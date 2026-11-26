import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import {
    closeJoining,
    closePhones,
    collectPageErrors,
    createGame,
    failOnDialogs,
    isVisible,
    joinGame,
    newPhone,
    readRoleCards,
    setName,
    startActualGame,
    waitForNight,
    waitForPointerReady,
    waitUntilHidden,
    waitUntilVisible,
} from '../lib/flows';
import type { Phone } from '../lib/flows';

// A seat belongs to a player, not to one socket. A second tab, a reopened link or a
// reconnect that reaches the server before the old socket times out all hold the same
// seat, and all of them have to keep receiving snapshots. Binding the seat to the newest
// socket only used to leave every other tab frozen on its last snapshot until a manual
// refresh - the production bug this file pins down.
//
// Each test opens the second tab from the *same browser context*, which is what a phone
// does when it reopens a link: same localStorage, same `playerUUID:<gameId>`.

interface ProbeState {
    loads: number;
    sent: Array<{ name: string; payload: any }>;
    syncs: Array<Record<string, any>>;
}

/**
 * Records what the page's own socket client does: how often the document loaded (so a
 * "live" update can be told apart from a reload), the events it emits, and the tailored
 * snapshots it receives. Installed as an init script so it survives a navigation.
 */
async function instrument(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const w = window as any;
        w.__live = { loads: 0, sent: [], syncs: [] };
        // sessionStorage outlives a reload but not a new tab: loads === 1 means "never reloaded".
        w.__live.loads = Number(sessionStorage.getItem('__liveLoads') ?? '0') + 1;
        sessionStorage.setItem('__liveLoads', String(w.__live.loads));

        const Native = window.WebSocket;
        class RecordingWebSocket extends Native {
            constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols);
                // Vite's HMR socket is not the game's.
                if (!String(url).includes('/socket.io/')) return;

                this.addEventListener('message', (event: MessageEvent) => {
                    if (typeof event.data !== 'string') return;
                    // engine.io may pack several packets into one frame.
                    for (const packet of event.data.split('\x1e')) {
                        if (!packet.startsWith('42')) continue;
                        try {
                            const [name, data] = JSON.parse(packet.slice(2));
                            if (name === 'syncState') w.__live.syncs.push(data);
                        } catch {
                            // not a socket.io EVENTS frame
                        }
                    }
                });
            }

            send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
                if (typeof data === 'string') {
                    for (const packet of data.split('\x1e')) {
                        if (!packet.startsWith('42')) continue;
                        try {
                            const [name, payload] = JSON.parse(packet.slice(2));
                            w.__live.sent.push({ name, payload });
                        } catch {
                            // not a socket.io EVENTS frame
                        }
                    }
                }
                super.send(data as any);
            }
        }

        window.WebSocket = RecordingWebSocket as any;
    });
}

const probe = (page: Page): Promise<ProbeState> =>
    page.evaluate(() => JSON.parse(JSON.stringify((window as any).__live ?? { loads: 0, sent: [], syncs: [] })));

const latestSnapshot = async (page: Page): Promise<Record<string, any> | null> => {
    const state = await probe(page);
    return state.syncs.length ? state.syncs[state.syncs.length - 1]! : null;
};

const stepKey = (snapshot: Record<string, any> | null): string =>
    snapshot ? `${snapshot.phase}|${snapshot.activeNightRole}|${snapshot.sheriffElectionDone}` : 'none';

const nameOf = (index: number): string => (index === 0 ? 'Gamemaster' : `Player ${index}`);

interface Table {
    code: string;
    gm: Page;
    phones: Phone[];
    /** Display name of the role dealt to phones[i]. Random: never assume a seat. */
    roles: string[];
}

/** Instrumented phones walked lobby -> distribution -> first night. */
async function startTable(browser: Browser, watch: (page: Page) => void): Promise<Table> {
    const phones: Phone[] = [];
    for (let i = 0; i < 4; i++) {
        const phone = await newPhone(browser);
        await instrument(phone.page);
        watch(phone.page);
        phones.push(phone);
    }

    const gm = phones[0]!.page;
    const code = await createGame(gm);
    await setName(gm, nameOf(0));
    for (let i = 1; i < phones.length; i++) {
        await joinGame(phones[i]!.page, code);
        await setName(phones[i]!.page, nameOf(i));
    }
    for (const { page } of phones) await expect(page.locator('#player-count')).toHaveText('4');

    await closeJoining(gm);
    const roles = await readRoleCards(phones);
    await startActualGame(gm);
    for (const { page } of phones) await waitForNight(page);

    return { code, gm, phones, roles };
}

/** Opens a second tab on an existing phone: same context, same localStorage, same seat. */
async function openSecondTab(phone: Phone, code: string, watch: (page: Page) => void): Promise<Page> {
    const second = await phone.context.newPage();
    await instrument(second);
    watch(second);
    await second.goto(`/#/game/${code}`);
    return second;
}

async function dismissDeathPopup(page: Page): Promise<void> {
    if (!(await isVisible(page, '#death-popup-overlay'))) return;
    await page.locator('#close-death-popup').click();
    await waitUntilHidden(page, '#death-popup-overlay');
}

/** One GM escape-hatch step, re-armed only after the next snapshot. */
async function advanceOnce(gm: Page): Promise<void> {
    await dismissDeathPopup(gm);
    const advanceBtn = gm.locator('#manager-advance-btn');
    await expect(advanceBtn).toBeEnabled();
    await advanceBtn.click();
    await expect(gm.locator('#manager-advance-confirm')).toBeVisible();
    await gm.locator('#manager-advance-confirm-btn').click();
    await expect(gm.locator('#manager-advance-confirm')).toBeHidden();
}

/** GM escape hatch until the table is in DAY, watching a specific phone for progress. */
async function advanceToDay(gm: Page, probePage: Page): Promise<void> {
    for (let step = 0; step < 12; step++) {
        const current = await latestSnapshot(probePage);
        if (current?.phase === 'DAY') return;

        const before = stepKey(current);
        await advanceOnce(gm);
        await expect
            .poll(async () => stepKey(await latestSnapshot(probePage)), { message: `the phone did not move past ${before}` })
            .not.toBe(before);
    }
    throw new Error('the GM escape hatch never reached DAY');
}

test.describe('live sync', () => {
    let phones: Phone[] = [];
    let pageErrors: string[] = [];
    let dialogs: string[] = [];

    const watch = (page: Page, allowConsoleError?: RegExp): void => {
        collectPageErrors(page, pageErrors, allowConsoleError);
        failOnDialogs(page, dialogs);
    };

    test.beforeEach(() => {
        phones = [];
        pageErrors = [];
        dialogs = [];
    });

    test.afterEach(async () => {
        // Closing a context also closes the extra tabs opened inside it.
        await closePhones(phones);
        phones = [];
        expect(dialogs, 'the app must never open a blocking dialog').toEqual([]);
        expect(pageErrors, 'the page must not throw or log console errors').toEqual([]);
    });

    test('two live tabs on one seat both follow the game, and the original survives the other closing', async ({ browser }) => {
        test.slow();

        for (let i = 0; i < 4; i++) {
            const phone = await newPhone(browser);
            await instrument(phone.page);
            watch(phone.page);
            phones.push(phone);
        }

        const gm = phones[0]!.page;
        const player = phones[1]!.page;
        const code = await createGame(gm);
        await setName(gm, nameOf(0));
        for (let i = 1; i < phones.length; i++) {
            await joinGame(phones[i]!.page, code);
            await setName(phones[i]!.page, nameOf(i));
        }
        for (const { page } of phones) await expect(page.locator('#player-count')).toHaveText('4');

        // The same phone reopening its link: same context, same stored playerUUID.
        const second = await openSecondTab(phones[1]!, code, watch);
        await waitUntilVisible(second, '#lobby-players-list');

        // Same seat, not a new player: same name, same count, same table on both tabs.
        await expect(second.locator('#my-name-input')).toHaveValue(nameOf(1));
        await expect(second.locator('#player-count')).toHaveText('4');
        await expect(gm.locator('#player-count')).toHaveText('4');
        expect(await second.locator('#lobby-players-list').innerText()).toBe(await player.locator('#lobby-players-list').innerText());
        expect((await latestSnapshot(second))!.playerUUID).toBe((await latestSnapshot(player))!.playerUUID);

        // Drive a phase change from the GM's phone only.
        await closeJoining(gm);

        // The tab that was NOT driven has to reach ROLE_SELECTION/DISTRIBUTION on its own,
        // without a reload, with the seat's own card.
        const secondCard = second.locator('#role-name-display');
        await expect(secondCard).not.toBeEmpty();
        await expect(player.locator('#role-name-display')).toHaveText((await secondCard.textContent())!.trim());
        await expect.poll(async () => (await latestSnapshot(second))?.phase ?? null).toBe('DISTRIBUTION');
        expect((await probe(second)).loads, 'the second tab must not have reloaded').toBe(1);

        await startActualGame(gm);

        await waitForNight(second);
        await waitForNight(player);
        await expect.poll(async () => (await latestSnapshot(second))?.phase ?? null).toBe('NIGHT');
        await expect(second.locator('#game-error-view')).toBeHidden();
        expect((await probe(second)).loads).toBe(1);

        // Now close the newer tab and change the phase once more: the original tab is the
        // only socket left on the seat and still has to be live. Before the fix this one
        // froze here, because the newer tab had taken the seat binding with it.
        await second.close();
        await advanceToDay(gm, player);
        await waitUntilVisible(player, '#day-nomination-view');
        await expect(player.locator('#game-error-view')).toBeHidden();
        await expect.poll(async () => (await latestSnapshot(player))?.phase ?? null).toBe('DAY');
        expect((await probe(player)).loads, 'the original tab must not have reloaded').toBe(1);
    });

    test('a resumed page re-announces its seat and catches up without a reload', async ({ browser }) => {
        test.slow();

        const table = await startTable(browser, watch);
        phones = table.phones;
        const player = phones[1]!.page;

        const before = await probe(player);
        const seat = (await latestSnapshot(player))!.playerUUID;
        const phase = (await latestSnapshot(player))!.phase;
        const activeRole = (await latestSnapshot(player))!.activeNightRole;
        expect(seat).toBeTruthy();

        // What a phone does when it comes back from the background.
        await player.evaluate(() => {
            window.dispatchEvent(new Event('pageshow'));
            window.dispatchEvent(new Event('online'));
        });

        // The re-announce is observable in the app's own outgoing traffic: joinGame with
        // the seat it already holds, answered by a fresh tailored snapshot.
        await expect
            .poll(
                async () => (await probe(player)).sent.filter((event) => event.name === 'joinGame').length,
                { message: 'the page never re-announced its seat' },
            )
            .toBeGreaterThan(before.sent.filter((event) => event.name === 'joinGame').length);

        const rejoins = (await probe(player)).sent.filter((event) => event.name === 'joinGame');
        const lastRejoin = rejoins[rejoins.length - 1]!;
        expect(lastRejoin.payload.playerUUID).toBe(seat);
        expect(lastRejoin.payload.gameId).toBe(table.code);

        await expect
            .poll(async () => (await probe(player)).syncs.length, { message: 'the re-announce was never answered with a snapshot' })
            .toBeGreaterThan(before.syncs.length);

        // Still the same seat, the same phase and the same turn - and nothing broke.
        const after = (await latestSnapshot(player))!;
        expect(after.playerUUID).toBe(seat);
        expect(after.phase).toBe(phase);
        expect(after.activeNightRole).toBe(activeRole);
        expect(after.players).toHaveLength(4);
        await expect(player.locator('#game-error-view')).toBeHidden();
        await expect(player.locator('#connection-banner')).toBeHidden();
        await waitForNight(player);
        expect((await probe(player)).loads, 'a resume must not reload the page').toBe(1);
    });

    test('a rejected action shows a toast instead of a blocking dialog', async ({ browser }) => {
        const phone = await newPhone(browser);
        phones = [phone];
        await instrument(phone.page);
        // The backend rejects this action on purpose and the client logs the socket error.
        watch(phone.page, /Socket Error:.*at least 4 are required/);

        await createGame(phone.page);
        await setName(phone.page, nameOf(0));

        // The tap-through guard is armed right after the route change into the game, so
        // the first real tap has to wait until the router accepts input.
        await waitForPointerReady(phone.page);

        // Closing the lobby with one player is a real server rejection reachable from the
        // real button (the backend requires four). The day-nomination duplicate cannot be
        // used for this: the client re-checks the latest snapshot and never emits, so it
        // never reaches the server.
        await phone.page.locator('#start-game-btn').click();

        await waitUntilVisible(phone.page, '#game-toast');
        await expect(phone.page.locator('#game-toast-message')).toContainText('at least 4');
        // A dialog would already have fired here; assert it inline, not only in afterEach.
        expect(dialogs, 'a rejection must not block the page with alert()').toEqual([]);

        // The whole point of dropping alert(): the page and its socket keep working.
        await expect(phone.page.locator('#connection-banner')).toBeHidden();
        await expect(phone.page.locator('#game-error-view')).toBeHidden();
        await expect(phone.page.locator('#my-name-input')).toBeVisible();
        await setName(phone.page, 'Still Here');

        const sentAfterRejection = (await probe(phone.page)).sent.filter((event) => event.name === 'changeName');
        expect(sentAfterRejection.length, 'the socket was not usable after the rejection').toBeGreaterThan(0);
        await expect(phone.page.locator('#player-count')).toHaveText('1');
    });

    test('a second tab does not cost the first tab its role chip or seat', async ({ browser }) => {
        test.slow();

        const table = await startTable(browser, watch);
        phones = table.phones;

        const player = phones[1]!;
        const dealt = table.roles[1]!;
        const seat = (await latestSnapshot(player.page))!.playerUUID;
        const roleBefore = (await latestSnapshot(player.page))!.role;
        expect(roleBefore).toBeTruthy();
        await waitUntilVisible(player.page, '#my-role-chip');
        await expect(player.page.locator('#my-role-chip-name')).toHaveText(dealt);

        const syncsBefore = (await probe(player.page)).syncs.length;
        const second = await openSecondTab(player, table.code, watch);
        await waitUntilVisible(second, '#my-role-chip');
        await expect(second.locator('#my-role-chip-name')).toHaveText(dealt);

        // Same seat, same role, no extra player: a second tab is a second window, not a
        // second seat.
        await expect.poll(async () => (await latestSnapshot(second))?.playerUUID ?? null).toBe(seat);
        expect((await latestSnapshot(second))!.role).toBe(roleBefore);
        await expect.poll(async () => (await latestSnapshot(table.gm))?.players?.length ?? null).toBe(4);
        const seatsNamed = ((await latestSnapshot(table.gm))!.players as Array<Record<string, any>>)
            .filter((entry) => entry.displayName === nameOf(1));
        expect(seatsNamed, 'the second tab must not create a second seat').toHaveLength(1);

        // The first tab was not orphaned by the new socket: it kept its chip and it is
        // still in the seat's fan-out (the second tab's join reached it as a snapshot).
        await expect(player.page.locator('#my-role-chip-name')).toHaveText(dealt);
        expect((await latestSnapshot(player.page))!.playerUUID).toBe(seat);
        expect((await probe(player.page)).syncs.length).toBeGreaterThan(syncsBefore);
        await expect(player.page.locator('#game-error-view')).toBeHidden();
        expect((await probe(player.page)).loads, 'the first tab must not have reloaded').toBe(1);
    });
});
