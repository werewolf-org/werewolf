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
    waitUntilVisible,
} from '../lib/flows';
import type { Phone } from '../lib/flows';

// Navigation, persistence and layout. The router is a 130-line hash router; every one
// of its branches (game route, start route, 404) and the per-game player identity keys
// (BUGS.md B18) are easier to check through a real browser than through the store.
//
// Snapshots are recorded exactly like reconnect.spec.ts does: the tailored snapshot is
// the only thing a player ever sees, so it is also the only honest source for "which
// seat am I in" and "which phase am I in".

/** Installs a WebSocket recorder before the app loads (survives reloads). */
async function recordSnapshots(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const target = window as any;
        target.__syncSnapshots = [];

        const Native = window.WebSocket;
        class RecordingWebSocket extends Native {
            constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols);
                this.addEventListener('message', (event) => {
                    if (typeof event.data !== 'string') return;
                    for (const packet of event.data.split('\x1e')) {
                        if (!packet.startsWith('42')) continue;
                        try {
                            const [name, data] = JSON.parse(packet.slice(2));
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

const snapshotsOf = (page: Page, gameId?: string): Promise<Record<string, any>[]> =>
    page.evaluate(
        (id) => {
            const all = ((window as any).__syncSnapshots ?? []) as Record<string, any>[];
            return id === null ? all : all.filter((snapshot) => snapshot.gameId === id);
        },
        gameId ?? null,
    );

const latestSnapshot = async (page: Page, gameId?: string): Promise<Record<string, any> | null> => {
    const snapshots = await snapshotsOf(page, gameId);
    return snapshots.length ? snapshots[snapshots.length - 1]! : null;
};

const nameOf = (index: number): string => (index === 0 ? 'Gamemaster' : `Player ${index}`);

interface Game {
    code: string;
    phones: Phone[];
    gm: Page;
    roles: string[];
}

/**
 * Four (or more) instrumented phones from the start page into the first night.
 * `playerCount` includes the games master. Every page deliberately has the start page
 * in its history so `goBack()` lands there, not on about:blank.
 */
async function startInstrumentedGame(browser: Browser, playerCount = 4, watch: (phone: Phone) => void): Promise<Game> {
    const phones: Phone[] = [];
    for (let i = 0; i < playerCount; i++) {
        const phone = await newPhone(browser);
        await recordSnapshots(phone.page);
        watch(phone);
        phones.push(phone);
    }

    const gm = phones[0]!.page;
    const code = await createGame(gm);
    await setName(gm, nameOf(0));

    for (let i = 1; i < phones.length; i++) {
        const page = phones[i]!.page;
        // A visible start page in the history: Back from the game has to land here.
        await page.goto('/');
        await waitUntilVisible(page, '#create-game');
        await joinGame(page, code);
        await setName(page, nameOf(i));
    }
    for (const { page } of phones) await expect(page.locator('#player-count')).toHaveText(String(playerCount));

    await closeJoining(gm);
    const roles = await readRoleCards(phones);
    await startActualGame(gm);
    for (const { page } of phones) await waitForNight(page);

    return { code, phones, gm, roles };
}

/** Instrumented phones walked to the role distribution card (game not started). */
async function startDistribution(browser: Browser, playerCount: number, watch: (phone: Phone) => void): Promise<Game> {
    const phones: Phone[] = [];
    for (let i = 0; i < playerCount; i++) {
        const phone = await newPhone(browser);
        await recordSnapshots(phone.page);
        watch(phone);
        phones.push(phone);
    }

    const gm = phones[0]!.page;
    const code = await createGame(gm);
    await setName(gm, nameOf(0));
    for (let i = 1; i < phones.length; i++) {
        await joinGame(phones[i]!.page, code);
        await setName(phones[i]!.page, nameOf(i));
    }
    for (const { page } of phones) await expect(page.locator('#player-count')).toHaveText(String(playerCount));

    await closeJoining(gm);
    const roles = await readRoleCards(phones);
    return { code, phones, gm, roles };
}

/** One GM escape-hatch stage, re-armed only after the next snapshot. */
async function advanceOnce(gm: Page): Promise<void> {
    const advanceBtn = gm.locator('#manager-advance-btn');
    await expect(advanceBtn).toBeEnabled();
    await advanceBtn.click();
    await expect(gm.locator('#manager-advance-confirm')).toBeVisible();
    await gm.locator('#manager-advance-confirm-btn').click();
    await expect(gm.locator('#manager-advance-confirm')).toBeHidden();
    await expect(advanceBtn).toBeEnabled();
}

async function advanceUntilVisible(gm: Page, selector: string, maxSteps = 12): Promise<void> {
    for (let step = 0; step < maxSteps; step++) {
        if (await isVisible(gm, selector)) return;
        await advanceOnce(gm);
    }
    await waitUntilVisible(gm, selector);
}

/** The phone whose #night-action-container is on screen. */
async function actingIndexes(phones: Phone[]): Promise<number[]> {
    let indexes: number[] = [];
    await expect
        .poll(
            async () => {
                const flags = await Promise.all(phones.map((phone) => isVisible(phone.page, '#night-action-container')));
                indexes = flags.flatMap((on, i) => (on ? [i] : []));
                return indexes.length;
            },
            { timeout: 15_000, message: 'no phone got a night action' },
        )
        .toBeGreaterThan(0);
    return indexes;
}

/** The primary night action button for the role that is awake on that phone. */
const PRIMARY_NIGHT_BUTTON: Record<string, string> = {
    Werewolf: '#confirm-werewolf-target-btn',
    Seer: '#confirm-seer-target-btn',
    Cupid: '#confirm-cupid-target-btn',
    'Red Lady': '#confirm-sleepover-btn',
    Witch: '#confirm-witch-actions-btn',
};

test.describe('navigation', () => {
    let phones: Phone[] = [];
    let pageErrors: string[] = [];
    let dialogs: string[] = [];

    const watch = (phone: Phone): void => {
        collectPageErrors(phone.page, pageErrors);
        failOnDialogs(phone.page, dialogs);
    };

    test.beforeEach(() => {
        phones = [];
        pageErrors = [];
        dialogs = [];
    });

    test.afterEach(async () => {
        await closePhones(phones);
        phones = [];
        expect(dialogs, 'the app must never open a blocking dialog').toEqual([]);
        expect(pageErrors, 'the page must not throw or log console errors').toEqual([]);
    });

    test('deep link into an open lobby joins as a new player and leaves the table intact', async ({ browser }) => {
        const gm = await newPhone(browser);
        const player = await newPhone(browser);
        const intruder = await newPhone(browser);
        phones = [gm, player, intruder];
        phones.forEach(watch);

        const code = await createGame(gm.page);
        await setName(gm.page, nameOf(0));
        await joinGame(player.page, code);
        await setName(player.page, nameOf(1));
        await expect(gm.page.locator('#player-count')).toHaveText('2');

        await intruder.page.goto(`/#/game/${code}`);
        await waitUntilVisible(intruder.page, '#lobby-players-list');

        // The lobby is still open, so the link is a legitimate way in: a fresh seat,
        // never somebody else's.
        await expect(intruder.page.locator('#my-name-input')).toHaveValue('');
        await expect(intruder.page.locator('#manager-controls')).toBeHidden();
        await expect(intruder.page.locator('#player-count')).toHaveText('3');

        // The existing table is unaffected: same count, same names, same manager.
        await expect(gm.page.locator('#player-count')).toHaveText('3');
        await expect(gm.page.locator('#manager-controls')).toBeVisible();
        await expect(player.page.locator('#my-name-input')).toHaveValue(nameOf(1));
        await expect(gm.page.locator('#lobby-players-list li').filter({ hasText: nameOf(1) })).toHaveCount(1);
    });

    test('deep link into a running night is refused and does not disturb the table', async ({ browser }) => {
        test.slow();

        const game = await startInstrumentedGame(browser, 4, watch);
        phones = [...game.phones];

        const before = await latestSnapshot(game.gm);
        expect(before?.phase).toBe('NIGHT');
        expect(before?.players).toHaveLength(4);

        const intruder = await newPhone(browser);
        await recordSnapshots(intruder.page);
        collectPageErrors(intruder.page, pageErrors, /no longer accepting new players/);
        failOnDialogs(intruder.page, dialogs);
        phones.push(intruder);

        await intruder.page.goto(`/#/game/${game.code}`);
        await expect(intruder.page.locator('#game-error-view')).toBeVisible();
        await expect(intruder.page.locator('#game-error-message')).toContainText('no longer accepting new players');
        await expect(intruder.page.locator('#game-error-back-btn')).toBeVisible();
        // A refusal is terminal and leaves the page legible, not blank.
        await expect(intruder.page.locator('#phase-view-container')).toBeHidden();
        expect(await latestSnapshot(intruder.page), 'the refused phone must not receive a snapshot').toBeNull();

        // Existing players keep their phase and their seats.
        for (const phone of game.phones) {
            await expect
                .poll(async () => (await isVisible(phone.page, '#night-action-container')) || (await isVisible(phone.page, '#night-sleep-view')))
                .toBe(true);
        }
        await expect(game.gm.locator('#manager-advance-view')).toBeVisible();
        await expect(game.gm.locator('#manager-advance-btn')).toBeEnabled();
        await expect.poll(async () => (await latestSnapshot(game.gm))?.players?.length ?? null).toBe(4);
        await expect.poll(async () => (await latestSnapshot(game.gm))?.phase ?? null).toBe('NIGHT');
    });

    test('deep link into a running day is refused and does not disturb the table', async ({ browser }) => {
        test.slow();

        const game = await startInstrumentedGame(browser, 4, watch);
        phones = [...game.phones];
        await advanceUntilVisible(game.gm, '#day-nomination-view');
        for (const { page } of game.phones) await expect(page.locator('#day-nomination-view')).toBeVisible();

        const intruder = await newPhone(browser);
        await recordSnapshots(intruder.page);
        collectPageErrors(intruder.page, pageErrors, /no longer accepting new players/);
        failOnDialogs(intruder.page, dialogs);
        phones.push(intruder);

        await intruder.page.goto(`/#/game/${game.code}`);
        await expect(intruder.page.locator('#game-error-view')).toBeVisible();
        await expect(intruder.page.locator('#game-error-message')).toContainText('no longer accepting new players');
        expect(await latestSnapshot(intruder.page)).toBeNull();

        for (const { page } of game.phones) await expect(page.locator('#day-nomination-view')).toBeVisible();
        await expect.poll(async () => (await latestSnapshot(game.gm))?.players?.length ?? null).toBe(4);
        await expect.poll(async () => (await latestSnapshot(game.gm))?.phase ?? null).toBe('DAY');
    });

    test('back to the start page and forward again rejoins the same seat in the current phase', async ({ browser }) => {
        test.slow();

        const game = await startInstrumentedGame(browser, 4, watch);
        phones = [...game.phones];

        const target = phones[3]!.page;
        const before = await latestSnapshot(target);
        expect(before).not.toBeNull();
        expect(before!.phase).toBe('NIGHT');
        expect(before!.displayName).toBe(nameOf(3));
        const seat = before!.playerUUID;

        await target.goBack();
        await waitUntilVisible(target, '#create-game');
        await expect(target).not.toHaveURL(/#\/game\//);

        // The table plays on while this phone sits on the start page.
        await advanceUntilVisible(game.gm, '#day-nomination-view');
        await expect(target.locator('#day-nomination-view')).toBeHidden();

        await target.goForward();
        await waitUntilVisible(target, '#day-nomination-view');

        // Not the lobby, not the night it left, not an error card: the *current* phase.
        await expect(target.locator('#game-error-view')).toBeHidden();
        const after = await latestSnapshot(target);
        expect(after).not.toBeNull();
        expect(after!.phase).toBe('DAY');
        expect(after!.playerUUID, 'Forward must restore the same seat, not create a new one').toBe(seat);
        expect(after!.displayName).toBe(nameOf(3));
    });

    test('the hash route is case-sensitive: a lowercase code shows the error card, not a blank page', async ({ browser }) => {
        const gm = await newPhone(browser);
        const player = await newPhone(browser);
        phones = [gm, player];
        watch(gm);
        // This flow makes the app log on purpose: the backend rejects the unknown id.
        collectPageErrors(player.page, pageErrors, /Game with ID .* not found/);
        failOnDialogs(player.page, dialogs);

        const code = await createGame(gm.page);
        await setName(gm.page, nameOf(0));

        await player.page.goto(`/#/game/${code.toLowerCase()}`);
        await expect(player.page.locator('#game-error-view')).toBeVisible();
        await expect(player.page.locator('#game-error-message')).toContainText('not found');
        await expect(player.page.locator('#game-error-back-btn')).toBeVisible();

        // The router does not silently normalise; the uppercase code still works.
        await expect(gm.page.locator('#player-count')).toHaveText('1');
        await player.page.goto(`/#/game/${code}`);
        await waitUntilVisible(player.page, '#lobby-players-list');
        await expect(player.page.locator('#game-error-view')).toBeHidden();
        await expect(gm.page.locator('#player-count')).toHaveText('2');
    });

    test('an unknown route redirects to the start page', async ({ browser }) => {
        const phone = await newPhone(browser);
        phones = [phone];
        watch(phone);

        await phone.page.goto('/#/nonsense');

        await expect(phone.page).toHaveURL(/#\/?$/, { timeout: 10_000 });
        await waitUntilVisible(phone.page, '#create-game');
        await expect(phone.page.locator('#game-error-view')).toHaveCount(0);
        await expect(phone.page.locator('#create-game')).toBeVisible();
    });

    test('two games in one context get separate seats, and reopening the first game keeps its seat (B18)', async ({ browser }) => {
        const gm = await newPhone(browser);
        const player = await newPhone(browser);
        phones = [gm, player];
        phones.forEach(watch);
        await recordSnapshots(player.page);

        const codeA = await createGame(gm.page);
        await setName(gm.page, nameOf(0));
        await joinGame(player.page, codeA);
        await setName(player.page, nameOf(1));
        await expect(gm.page.locator('#player-count')).toHaveText('2');

        await expect.poll(async () => (await latestSnapshot(player.page, codeA))?.playerUUID ?? null).not.toBeNull();
        const seatA = (await latestSnapshot(player.page, codeA))!.playerUUID as string;

        // Leave A for the start page, then create a second game B on the same phone.
        await player.page.goto('/');
        await waitUntilVisible(player.page, '#create-game');
        const codeB = await createGame(player.page);

        // B must not inherit A's seat: a shared id used to do exactly that.
        await expect.poll(async () => (await latestSnapshot(player.page, codeB))?.isManager ?? null).toBe(true);
        const snapshotB = (await latestSnapshot(player.page, codeB))!;
        const seatB = snapshotB.playerUUID as string;
        expect(seatB).not.toBe(seatA);
        await expect(player.page.locator('#player-count')).toHaveText('1');
        await expect(player.page.locator('#lobby-players-list')).not.toContainText(nameOf(1));

        // The two ids live under separate per-game keys.
        const stored = await player.page.evaluate(() => ({ ...localStorage }));
        expect(stored[`playerUUID:${codeA}`]).toBe(seatA);
        expect(stored[`playerUUID:${codeB}`]).toBe(seatB);

        // Reopening A's link rejoins A's seat, not B's.
        const countABefore = (await snapshotsOf(player.page, codeA)).length;
        await player.page.goto(`/#/game/${codeA}`);
        await waitUntilVisible(player.page, '#lobby-players-list');
        await expect
            .poll(async () => (await snapshotsOf(player.page, codeA)).length, { message: 'no fresh snapshot for game A arrived' })
            .toBeGreaterThan(countABefore);

        const snapshotA = (await latestSnapshot(player.page, codeA))!;
        expect(snapshotA.playerUUID).toBe(seatA);
        expect(snapshotA.displayName).toBe(nameOf(1));
        expect(snapshotA.isManager).toBe(false);
        await expect(player.page.locator('#my-name-input')).toHaveValue(nameOf(1));
        await expect(gm.page.locator('#player-count')).toHaveText('2');
        await expect(gm.page.locator('#lobby-players-list li').filter({ hasText: nameOf(1) })).toHaveCount(1);
    });

    test('reloading on the role distribution card brings the same role back', async ({ browser }) => {
        test.slow();

        const game = await startDistribution(browser, 4, watch);
        phones = game.phones;

        const reloaded = phones[2]!.page;
        const roleBefore = (await reloaded.locator('#role-name-display').textContent())?.trim() ?? '';
        expect(roleBefore).not.toBe('');
        expect(game.roles[2]).toBe(roleBefore);

        await reloaded.reload();
        await waitUntilVisible(reloaded, '#role-name-display');
        await expect(reloaded.locator('#role-name-display')).toHaveText(roleBefore);
        await expect(reloaded.locator('#game-error-view')).toBeHidden();

        // The role is part of the snapshot, so it survives without any local copy.
        await expect.poll(async () => (await latestSnapshot(reloaded))?.phase ?? null).toBe('DISTRIBUTION');
        const snapshot = (await latestSnapshot(reloaded))!;
        expect(snapshot.role).toBeTruthy();
        expect(snapshot.displayName).toBe(nameOf(2));

        // Starting the game is still possible after one player reloaded.
        await startActualGame(game.gm);
        for (const { page } of game.phones) await waitForNight(page);
    });

    test('refreshing on GAME_OVER brings the summary back, not an error', async ({ browser }) => {
        test.slow();

        const game = await startInstrumentedGame(browser, 4, watch);
        phones = [...game.phones];
        const gm = game.gm;

        // The 4-player preset is exactly one Werewolf, two Villagers and a Seer. Skip
        // night and sheriff election, then lynch that one wolf: the village wins.
        const wolfIndex = game.roles.indexOf('Werewolf');
        if (wolfIndex < 0) throw new Error(`the 4-player preset must deal a Werewolf, got ${game.roles.join(', ')}`);
        const voterIndex = (wolfIndex + 1) % game.phones.length;
        const voter = phones[voterIndex]!.page;

        await advanceUntilVisible(gm, '#day-nomination-view');
        for (const { page } of game.phones) await expect(page.locator('#day-nomination-view')).toBeVisible();

        const candidate = voter.locator('#day-nomination-list li.nomination-item').filter({ hasText: nameOf(wolfIndex) });
        await expect(candidate).toHaveCount(1);
        await candidate.click();
        await voter.locator('#confirm-nomination-btn').click();
        await expect(voter.locator('#nomination-confirmed-message')).toBeVisible();

        await advanceOnce(gm);
        for (const { page } of game.phones) await expect(page.locator('#day-voting-view')).toBeVisible();

        const votingItem = voter.locator('#day-vote-list li.voting-item').filter({ hasText: nameOf(wolfIndex) });
        await expect(votingItem).toHaveCount(1);
        await votingItem.click();
        await voter.locator('#confirm-vote-btn').click();
        await expect(voter.locator('#vote-confirmed-message')).toBeVisible();

        await advanceOnce(gm);
        await waitUntilVisible(voter, '#winner-team-text');
        await expect(voter.locator('#winner-team-text')).toHaveText('The Village Wins!');
        await expect(voter.locator('#final-roles-list li')).toHaveCount(4);
        await expect.poll(async () => (await latestSnapshot(voter))?.phase ?? null).toBe('GAME_OVER');
        const winningTeam = (await latestSnapshot(voter))!.winningTeam;
        expect(winningTeam).toBe('village');

        await voter.reload();
        await waitUntilVisible(voter, '#winner-team-text');
        await expect(voter.locator('#game-error-view')).toBeHidden();
        await expect(voter.locator('#winner-team-text')).toHaveText('The Village Wins!');
        await expect(voter.locator('#final-roles-list li')).toHaveCount(4);
        await expect.poll(async () => (await latestSnapshot(voter))?.phase ?? null).toBe('GAME_OVER');
    });

    test('layout: no horizontal overflow on the phone viewport', async ({ browser }) => {
        test.slow();

        for (let i = 0; i < 4; i++) {
            const phone = await newPhone(browser);
            watch(phone);
            phones.push(phone);
        }
        const gm = phones[0]!.page;

        const assertNoOverflow = async (page: Page, where: string): Promise<void> => {
            const metrics = await page.evaluate(() => ({
                scrollWidth: document.documentElement.scrollWidth,
                innerWidth: window.innerWidth,
            }));
            expect(
                metrics.scrollWidth,
                `${where}: page is ${metrics.scrollWidth}px wide in a ${metrics.innerWidth}px viewport`,
            ).toBeLessThanOrEqual(metrics.innerWidth + 1);
        };

        await gm.goto('/');
        await waitUntilVisible(gm, '#create-game');
        await assertNoOverflow(gm, 'start page');

        const code = await createGame(gm);
        await setName(gm, nameOf(0));
        for (let i = 1; i < phones.length; i++) {
            await joinGame(phones[i]!.page, code);
            await setName(phones[i]!.page, nameOf(i));
        }
        for (const { page } of phones) await expect(page.locator('#player-count')).toHaveText('4');
        await assertNoOverflow(gm, 'lobby (game master)');
        await assertNoOverflow(phones[1]!.page, 'lobby (player)');

        await closeJoining(gm);
        await readRoleCards(phones);
        await startActualGame(gm);
        for (const { page } of phones) await waitForNight(page);

        const actors = await actingIndexes(phones);
        await assertNoOverflow(phones[actors[0]!]!.page, 'night action view');
        const bystanderIndex = phones.findIndex((_, index) => index !== 0 && !actors.includes(index));
        if (bystanderIndex >= 0) await assertNoOverflow(phones[bystanderIndex]!.page, 'night sleep view');

        await advanceUntilVisible(gm, '#day-nomination-view');
        const dayPhone = phones[1]!.page;
        await waitUntilVisible(dayPhone, '#day-nomination-view');
        await assertNoOverflow(dayPhone, 'day nomination list');
    });

    test('tap targets: the primary night action button is at least 40px tall', async ({ browser }) => {
        test.slow();

        for (let i = 0; i < 4; i++) {
            const phone = await newPhone(browser);
            watch(phone);
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

        const actors = await actingIndexes(phones);
        const actorIndex = actors[0]!;
        const role = roles[actorIndex]!;
        const selector = PRIMARY_NIGHT_BUTTON[role];
        if (!selector) throw new Error(`no primary button mapped for role ${role}`);
        const button = phones[actorIndex]!.page.locator(selector);
        await expect(button).toBeVisible();

        const box = await button.boundingBox();
        expect(box, `${role}: the primary action button has no box`).not.toBeNull();
        expect(box!.height, `${role}: ${selector} is only ${box!.height.toFixed(1)}px tall`).toBeGreaterThanOrEqual(40);
        expect(box!.width, `${role}: ${selector} is only ${box!.width.toFixed(1)}px wide`).toBeGreaterThanOrEqual(40);
    });
});
