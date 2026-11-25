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
    setName,
    startActualGame,
    waitForNight,
    waitForPointerReady,
    waitUntilVisible,
} from '../lib/flows';
import type { Phone } from '../lib/flows';

// Reconnect contract (B15/B17/B18): a reload must land back in the same seat and the
// same phase, and a second tab must never inherit a seat it was not given.

/**
 * Records the socket.io traffic this phone receives. The DAY view does not print the
 * player's own role anywhere, so the tailored snapshot is the only place a player can
 * actually see it — and it is what the store and every view are built from. Installed
 * as an init script so it survives the reload under test.
 */
async function recordSnapshots(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const target = window as any;
        target.__socketEvents = [];
        target.__syncSnapshots = [];

        const Native = window.WebSocket;
        class RecordingWebSocket extends Native {
            constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols);
                this.addEventListener('message', (event) => {
                    if (typeof event.data !== 'string') return;
                    // engine.io may pack several packets into one frame.
                    for (const packet of event.data.split('\x1e')) {
                        if (!packet.startsWith('42')) continue;
                        try {
                            const [name, data] = JSON.parse(packet.slice(2));
                            target.__socketEvents.push(name);
                            if (name === 'syncState') target.__syncSnapshots.push(data);
                        } catch {
                            // not a socket.io EVENTS frame
                        }
                    }
                });
            }
        }
        window.WebSocket = RecordingWebSocket as any;
    });
}

const latestSnapshot = (page: Page): Promise<Record<string, any> | null> =>
    page.evaluate(() => {
        const snapshots = (window as any).__syncSnapshots ?? [];
        return snapshots.length ? snapshots[snapshots.length - 1] : null;
    });

const stepKey = (snapshot: Record<string, any> | null): string =>
    snapshot ? `${snapshot.phase}|${snapshot.activeNightRole}|${snapshot.sheriffElectionDone}` : 'none';

/** Uses the GM escape hatch one step at a time until the whole table is in DAY. */
async function advanceToDay(gm: Page, probe: Page): Promise<void> {
    for (let step = 0; step < 12; step++) {
        const current = await latestSnapshot(probe);
        if (current?.phase === 'DAY') return;

        const before = stepKey(current);
        await gm.locator('#manager-advance-btn').click();
        await gm.locator('#manager-advance-confirm-btn').click();
        await expect
            .poll(async () => stepKey(await latestSnapshot(probe)), { message: `server did not move past ${before}` })
            .not.toBe(before);
    }
    throw new Error('the GM escape hatch never reached DAY');
}

/** Four instrumented phones in a started game; the first one is the game manager. */
async function fourPhonesInNight(browser: Browser): Promise<Phone[]> {
    const phones: Phone[] = [];
    for (let i = 0; i < 4; i++) {
        const phone = await newPhone(browser);
        await recordSnapshots(phone.page);
        phones.push(phone);
    }

    const gm = phones[0]!.page;
    const code = await createGame(gm);
    await setName(gm, 'Gamemaster');

    for (let i = 1; i < phones.length; i++) {
        await joinGame(phones[i]!.page, code);
        await setName(phones[i]!.page, `Player ${i}`);
    }
    for (const { page } of phones) await expect(page.locator('#player-count')).toHaveText('4');

    await closeJoining(gm);
    await startActualGame(gm);
    for (const { page } of phones) await waitForNight(page);

    return phones;
}

test.describe('reconnect', () => {
    let phones: Phone[] = [];
    let pageErrors: string[] = [];
    let dialogs: string[] = [];

    test.afterEach(async () => {
        await closePhones(phones);
        phones = [];
        expect(dialogs, 'the app must never open a blocking dialog').toEqual([]);
        expect(pageErrors, 'the page must not throw or log console errors').toEqual([]);
        pageErrors = [];
        dialogs = [];
    });

    test('reload in the lobby keeps your seat', async ({ browser }) => {
        const gm = await newPhone(browser);
        const player = await newPhone(browser);
        phones = [gm, player];
        phones.forEach(({ page }) => {
            collectPageErrors(page, pageErrors);
            failOnDialogs(page, dialogs);
        });

        const code = await createGame(gm.page);
        await setName(gm.page, 'Gamemaster');
        await joinGame(player.page, code);
        await setName(player.page, 'Player 1');

        await expect(gm.page.locator('#player-count')).toHaveText('2');
        await expect(player.page.locator('#player-count')).toHaveText('2');
        await expect(gm.page.locator('#lobby-players-list')).toContainText('Player 1');

        await player.page.reload();

        // The reload has to pass through the cold-start gate, so wait for the lobby itself.
        await waitUntilVisible(player.page, '#lobby-players-list');
        await expect(player.page.locator('#player-count')).toHaveText('2');
        await expect(player.page.locator('#my-name-input')).toHaveValue('Player 1');

        // The other phone sees the same single seat, not a duplicated ghost player.
        await expect(gm.page.locator('#player-count')).toHaveText('2');
        await expect(gm.page.locator('#lobby-players-list li').filter({ hasText: 'Player 1' })).toHaveCount(1);
        await expect(gm.page.locator('#manager-controls')).toBeVisible();
    });

    test('reload mid-game keeps role and seat', async ({ browser }) => {
        test.slow();

        phones = await fourPhonesInNight(browser);
        phones.forEach(({ page }) => {
            collectPageErrors(page, pageErrors);
            failOnDialogs(page, dialogs);
        });

        const gm = phones[0]!.page;
        const reloaded = phones[1]!.page;
        await advanceToDay(gm, reloaded);
        await waitUntilVisible(reloaded, '#day-nomination-view');

        const beforeReload = await latestSnapshot(reloaded);
        expect(beforeReload, 'the phone never saw a snapshot').not.toBeNull();
        expect(beforeReload!.phase).toBe('DAY');
        expect(beforeReload!.displayName).toBe('Player 1');
        const roleBefore = beforeReload!.role;
        const seatBefore = beforeReload!.playerUUID;
        expect(roleBefore).toBeTruthy();

        await reloaded.reload();

        // Back into DAY, not into the lobby and not into the error card.
        await waitUntilVisible(reloaded, '#day-nomination-view');
        await expect(reloaded.locator('#game-error-view')).toBeHidden();
        await expect(reloaded.locator('#phase-view-container')).toBeVisible();
        expect(await isVisible(reloaded, '#lobby-players-list')).toBe(false);
        await expect(reloaded).toHaveURL(/#\/game\/[A-Z0-9]+$/);

        // The init script starts a fresh recording on the reloaded document, so this
        // snapshot can only be one that arrived after the reload.
        await expect
            .poll(async () => (await latestSnapshot(reloaded))?.phase ?? null, { message: 'no snapshot arrived after the reload' })
            .toBe('DAY');
        const afterReload = (await latestSnapshot(reloaded))!;
        expect(afterReload.role).toBe(roleBefore);
        expect(afterReload.playerUUID).toBe(seatBefore);
        expect(afterReload.displayName).toBe('Player 1');

        // The other phones still have exactly one seat with that name.
        await expect(gm.locator('#day-available-list .player-name').filter({ hasText: 'Player 1' })).toHaveCount(1);
    });

    test('a second tab does not steal the seat', async ({ browser }) => {
        test.slow();

        const gm = await newPhone(browser);
        const player = await newPhone(browser);
        const intruder = await newPhone(browser);
        phones = [gm, player, intruder];
        for (const { page } of phones) {
            await recordSnapshots(page);
            collectPageErrors(page, pageErrors);
            failOnDialogs(page, dialogs);
        }

        const code = await createGame(gm.page);
        await setName(gm.page, 'Gamemaster');
        await joinGame(player.page, code);
        await setName(player.page, 'Player 1');
        await expect(gm.page.locator('#player-count')).toHaveText('2');

        // A fresh context has no per-game playerUUID: the lobby has to take it in as a
        // new player, never as the seat somebody else already holds.
        await intruder.page.goto(`/#/game/${code}`);
        await waitUntilVisible(intruder.page, '#lobby-players-list');

        await expect(gm.page.locator('#player-count')).toHaveText('3');
        await expect(intruder.page.locator('#my-name-input')).toHaveValue('');
        await expect(intruder.page.locator('#manager-controls')).toBeHidden();

        await expect.poll(async () => (await latestSnapshot(intruder.page))?.playerUUID ?? null).not.toBeNull();
        await expect.poll(async () => (await latestSnapshot(gm.page))?.players?.length ?? null).toBe(3);
        await expect.poll(async () => (await latestSnapshot(player.page))?.playerUUID ?? null).not.toBeNull();

        const intruderSeat = (await latestSnapshot(intruder.page))!.playerUUID;
        expect(intruderSeat).not.toBe((await latestSnapshot(gm.page))!.playerUUID);
        expect(intruderSeat).not.toBe((await latestSnapshot(player.page))!.playerUUID);
        expect((await latestSnapshot(intruder.page))!.isManager).toBe(false);

        // The original phone still owns its seat and can still act on it.
        const playerSeat = (await latestSnapshot(player.page))!.playerUUID;
        await setName(player.page, 'Player 1 stays');
        await expect(gm.page.locator('#lobby-players-list')).toContainText('Player 1 stays');
        await expect(intruder.page.locator('#lobby-players-list li').filter({ hasText: 'Player 1 stays' })).toHaveCount(1);
        await expect(player.page.locator('#my-name-input')).toHaveValue('Player 1 stays');
        expect((await latestSnapshot(player.page))!.playerUUID).toBe(playerSeat);
    });

    test('the error card leads back to a working start page', async ({ browser }) => {
        const phone = await newPhone(browser);
        phones = [phone];
        collectPageErrors(phone.page, pageErrors, /Game with ID ZZZZ not found/);
        failOnDialogs(phone.page, dialogs);

        await phone.page.goto('/#/game/ZZZZ');
        await expect(phone.page.locator('#game-error-view')).toBeVisible();

        // The error card was reached by a route change, so input is ignored for a moment.
        await waitForPointerReady(phone.page);
        await phone.page.locator('#game-error-back-btn').click();

        // The back button goes through the router, so the game page is torn down.
        await expect(phone.page).toHaveURL(/#\/?$/, { timeout: 10_000 });
        await expect(phone.page.locator('#create-game')).toBeVisible();
        await expect(phone.page.locator('#game-error-view')).toHaveCount(0);
        await waitForPointerReady(phone.page);

        const code = await createGame(phone.page);
        await expect(phone.page.locator('#lobby-game-id')).toHaveText(code);
        await expect(phone.page.locator('#player-count')).toHaveText('1');
    });
});
