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
    nominate,
    setName,
    startActualGame,
    startGameWithPlayers,
    voteForSheriff,
    waitForNight,
    waitUntilHidden,
    waitUntilVisible,
} from '../lib/flows';
import type { Phone } from '../lib/flows';

// The remaining full-screen flows: sheriff election, the day result, game over, and the
// two layout stresses (a full lobby, a very long name). Rules live in the backend suite;
// this file asserts what a phone shows and that nothing runs off the screen.

interface Table {
    gm: Page;
    phones: Phone[];
}

const nameOf = (index: number): string => (index === 0 ? 'Gamemaster' : `Player ${index}`);

/** One stage of the GM escape hatch, exactly as in the gameplay spec (arm, confirm, re-arm). */
async function advanceOnce(gm: Page): Promise<void> {
    const advanceBtn = gm.locator('#manager-advance-btn');
    await expect(advanceBtn).toBeVisible();
    await expect(advanceBtn).toBeEnabled();
    await advanceBtn.click();

    const confirm = gm.locator('#manager-advance-confirm');
    await expect(confirm).toBeVisible();
    await gm.locator('#manager-advance-confirm-btn').click();
    await expect(confirm).toBeHidden();

    await expect(advanceBtn).toBeEnabled();
}

async function dismissDeathPopup(page: Page): Promise<void> {
    if (!(await isVisible(page, '#death-popup-overlay'))) return;
    await page.locator('#close-death-popup').click();
    await waitUntilHidden(page, '#death-popup-overlay');
}

async function advance(game: Table): Promise<void> {
    await dismissDeathPopup(game.gm);
    await advanceOnce(game.gm);
    await dismissDeathPopup(game.gm);
}

async function advanceUntil(game: Table, done: () => Promise<boolean>, maxSteps = 16): Promise<void> {
    for (let step = 0; step < maxSteps; step++) {
        if (await done()) return;
        await advance(game);
    }
    expect(await done(), 'the game never reached the expected screen').toBe(true);
}

async function advanceUntilVisibleOn(game: Table, selector: string, maxSteps = 16): Promise<void> {
    await advanceUntil(game, () => isVisible(game.gm, selector), maxSteps);
}

/** Lobby with `count` phones, standard names, everyone joined. Does not start the game. */
async function openLobby(browser: Browser, count: number): Promise<{ phones: Phone[]; gm: Page; code: string }> {
    const opened: Phone[] = [];
    for (let i = 0; i < count; i++) opened.push(await newPhone(browser));

    const gm = opened[0]!.page;
    const code = await createGame(gm);
    await setName(gm, nameOf(0));
    for (let i = 1; i < count; i++) {
        await joinGame(opened[i]!.page, code);
        await setName(opened[i]!.page, nameOf(i));
    }
    for (const phone of opened) {
        await expect(phone.page.locator('#player-count')).toHaveText(String(count));
    }
    return { phones: opened, gm, code };
}

/** How far the document is wider than the phone screen. 0 means no sideways scrolling. */
async function pageOverflow(page: Page): Promise<number> {
    return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/** How far one list row's content is wider than the row itself (a clipped/wrapped name). */
async function rowOverflow(page: Page, listSelector: string, text: string): Promise<number> {
    const row = page.locator(`${listSelector} li`).filter({ hasText: text }).first();
    await expect(row).toHaveCount(1);
    return row.evaluate((el) => el.scrollWidth - el.clientWidth);
}

test.describe('screens', () => {
    let phones: Phone[] = [];
    let pageErrors: string[] = [];
    let dialogs: string[] = [];

    const watch = (opened: Phone[]): void => {
        for (const phone of opened) {
            collectPageErrors(phone.page, pageErrors);
            failOnDialogs(phone.page, dialogs);
        }
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

    test('sheriff election: a direct vote on every living player, only the elected sheriff may accept', async ({ browser }) => {
        test.slow();

        const game = await startGameWithPlayers(browser, 6);
        phones = game.phones;
        watch(phones);
        const gm = game.gm;

        // Skip the whole first night: the election opens on the phones, already on the ballot.
        await advanceUntilVisibleOn(game, '#sheriff-voting-view', 10);
        for (const phone of phones) await expect(phone.page.locator('#sheriff-voting-view')).toBeVisible();

        // The nomination stage is gone, not merely hidden: none of its controls exist any more.
        for (const retired of [
            '#sheriff-nomination-view',
            '#sheriff-nomination-list',
            '#sheriff-nomination-controls',
            '#confirm-sheriff-nomination-btn',
            '#sheriff-nomination-confirmed-message',
        ]) {
            for (const phone of phones) await expect(phone.page.locator(retired)).toHaveCount(0);
        }

        // Every living seat is a candidate from the first snapshot, plus the abstain row.
        for (const phone of phones) {
            await expect(phone.page.locator('#sheriff-vote-list li.selectable-player')).toHaveCount(phones.length + 1);
            await expect(phone.page.locator('#sheriff-vote-list')).toContainText('Abstain from Vote');
            for (let index = 0; index < phones.length; index++) {
                await expect(phone.page.locator('#sheriff-vote-list')).toContainText(nameOf(index));
            }
        }
        await expect(gm.locator('#sheriff-vote-progress')).toHaveText(`0/${phones.length} players have voted`);

        const targetIndex = game.roles.findIndex((role, index) => index !== 0 && (role === 'Villager' || role === 'Seer'));
        expect(targetIndex).toBeGreaterThan(0);
        const targetName = nameOf(targetIndex);
        const otherVoterIndex = targetIndex === 1 ? 2 : 1;

        // Every living phone votes for the same seat; the last ballot resolves the election.
        for (let i = 0; i < phones.length; i++) {
            const page = phones[i]!.page;
            await expect(page.locator('#sheriff-voting-view')).toBeVisible();
            await voteForSheriff(page, targetName);
            if (i < phones.length - 1) {
                await expect(page.locator('#sheriff-vote-confirmed-message')).toBeVisible();
            }
        }

        for (const phone of phones) await expect(phone.page.locator('#sheriff-result-view')).toBeVisible();
        await expect(gm.locator('#elected-sheriff-name')).toHaveText(targetName);
        await expect(gm.locator('#sheriff-vote-breakdown')).toContainText(`${phones.length} Votes`);

        // Only the elected seat gets the badge; everyone else waits.
        const elected = phones[targetIndex]!.page;
        await expect(elected.locator('#sheriff-accept-controls')).toBeVisible();
        await expect(elected.locator('#accept-sheriff-btn')).toBeVisible();
        const notElected = phones[otherVoterIndex]!.page;
        await expect(notElected.locator('#sheriff-accept-controls')).toBeHidden();
        await expect(notElected.locator('#accept-sheriff-btn')).toBeHidden();
        await expect(notElected.locator('#sheriff-waiting-message')).toBeVisible();

        // The manager escape hatch stays reachable while the badge is pending...
        await waitUntilVisible(gm, '#manager-advance-view');
        await expect(gm.locator('#manager-advance-btn')).toBeEnabled();

        // ...and the elected phone really carries the table into the day.
        await elected.locator('#accept-sheriff-btn').click();
        for (const phone of phones) await expect(phone.page.locator('#day-nomination-view')).toBeVisible();
    });

    test('sheriff election: an abstain-only ballot elects nobody, and only the GM continues', async ({ browser }) => {
        test.slow();

        const game = await startGameWithPlayers(browser, 4);
        phones = game.phones;
        watch(phones);
        const gm = game.gm;

        await advanceUntilVisibleOn(game, '#sheriff-voting-view', 10);
        for (const phone of phones) {
            await expect(phone.page.locator('#sheriff-voting-view')).toBeVisible();
            await expect(phone.page.locator('#confirm-sheriff-nomination-btn')).toHaveCount(0);
        }

        for (let i = 0; i < phones.length; i++) {
            await voteForSheriff(phones[i]!.page, null);
            if (i < phones.length - 1) {
                await expect(phones[i]!.page.locator('#sheriff-vote-confirmed-message')).toBeVisible();
            }
        }

        // An all-abstain ballot resolves to "No One": no badge, no acceptance screen.
        for (const phone of phones) {
            await expect(phone.page.locator('#sheriff-result-view')).toBeVisible();
            await expect(phone.page.locator('#elected-sheriff-name')).toHaveText('No One');
            await expect(phone.page.locator('#no-sheriff-text')).toBeVisible();
            await expect(phone.page.locator('#sheriff-accept-controls')).toBeHidden();
            await expect(phone.page.locator('#accept-sheriff-btn')).toBeHidden();
        }

        // Only the GM may move the table on; everybody else waits for that.
        await expect(gm.locator('#gm-continue-controls')).toBeVisible();
        await expect(gm.locator('#gm-continue-btn')).toBeVisible();
        for (const phone of phones.slice(1)) {
            await expect(phone.page.locator('#gm-continue-controls')).toBeHidden();
            await expect(phone.page.locator('#no-sheriff-waiting-message')).toBeVisible();
        }

        await gm.locator('#gm-continue-btn').click();
        for (const phone of phones) await expect(phone.page.locator('#day-nomination-view')).toBeVisible();
    });

    test('day result: the lynched name, the vote count, the death popup with the role, ready-for-night for the living only', async ({ browser }) => {
        test.slow();

        const game = await startGameWithPlayers(browser, 6);
        phones = game.phones;
        watch(phones);
        const gm = game.gm;

        await advanceUntilVisibleOn(game, '#day-nomination-view', 12);

        // Never lynch the GM here: the manager is the one who can move the table on.
        const targetIndex = game.roles.findIndex((role, index) => index !== 0 && (role === 'Villager' || role === 'Seer'));
        expect(targetIndex).toBeGreaterThan(0);
        const targetName = nameOf(targetIndex);
        const targetRole = game.roles[targetIndex]!;
        const voters = [...phones.keys()].filter((index) => index !== targetIndex).slice(0, 2);

        // Nominations: one real nomination, everybody else passes.
        for (let i = 0; i < phones.length; i++) {
            const page = phones[i]!.page;
            await expect(page.locator('#day-nomination-view')).toBeVisible();
            await nominate(page, i === voters[0] ? targetName : null);
            if (i < phones.length - 1) {
                await expect(page.locator('#nomination-confirmed-message')).toBeVisible();
            }
        }

        for (const phone of phones) await expect(phone.page.locator('#day-voting-view')).toBeVisible();
        await expect(gm.locator('#day-vote-list')).toContainText(targetName);

        // Two votes for the accused, four abstains. The last cast resolves the lynch.
        for (let i = 0; i < phones.length; i++) {
            const page = phones[i]!.page;
            await expect(page.locator('#day-voting-view')).toBeVisible();
            const list = page.locator('#day-vote-list');
            if (voters.includes(i)) {
                const candidate = list.locator('li.voting-item').filter({ hasText: targetName });
                await expect(candidate).toHaveCount(1);
                await candidate.click();
            } else {
                await list.locator('li.voting-item[data-uuid="false"]').click();
            }
            await page.locator('#confirm-vote-btn').click();
            if (i < phones.length - 1) {
                await expect(page.locator('#vote-confirmed-message')).toBeVisible();
            }
        }

        for (const phone of phones) await expect(phone.page.locator('#day-result-view')).toBeVisible();
        await expect(gm.locator('#lynched-player-name')).toHaveText(targetName);
        await expect(gm.locator('#day-vote-breakdown')).toContainText('2 Votes');

        // The death announcement names the lynched player and reveals their role.
        await expect(gm.locator('#death-popup-overlay')).toBeVisible();
        await expect(gm.locator('#newly-dead-list')).toContainText(targetName);
        await expect(gm.locator('#newly-dead-list')).toContainText(targetRole);
        const dead = phones[targetIndex]!.page;
        await expect(dead.locator('#death-popup-overlay')).toBeVisible();
        await expect(dead.locator('#newly-dead-list')).toContainText(targetName);

        // The dead cannot send the village to night; the living can.
        await expect(dead.locator('#ready-for-night-btn')).toBeHidden();
        const living = phones[voters[0]!]!.page;
        await expect(living.locator('#ready-for-night-btn')).toBeVisible();
    });

    test('game over: winning team, every seat revealed, and the way back home', async ({ browser }) => {
        test.slow();

        // 4 players: one wolf. Lynching it ends the game for the village.
        const game = await startGameWithPlayers(browser, 4);
        phones = game.phones;
        watch(phones);
        const gm = game.gm;

        const wolfIndex = game.roles.indexOf('Werewolf');
        expect(wolfIndex, `the 4-player preset must deal a Werewolf, got ${game.roles.join(', ')}`).toBeGreaterThanOrEqual(0);
        const wolfName = nameOf(wolfIndex);
        const voterIndex = [...phones.keys()].find((index) => index !== wolfIndex)!;

        await advanceUntilVisibleOn(game, '#day-nomination-view', 12);

        // Nominate the wolf, then vote it out.
        for (let i = 0; i < phones.length; i++) {
            const page = phones[i]!.page;
            await nominate(page, i === voterIndex ? wolfName : null);
            if (i < phones.length - 1) await expect(page.locator('#nomination-confirmed-message')).toBeVisible();
        }
        for (const phone of phones) await expect(phone.page.locator('#day-voting-view')).toBeVisible();

        for (let i = 0; i < phones.length; i++) {
            const page = phones[i]!.page;
            const list = page.locator('#day-vote-list');
            if (i === voterIndex) {
                const candidate = list.locator('li.voting-item').filter({ hasText: wolfName });
                await expect(candidate).toHaveCount(1);
                await candidate.click();
            } else {
                await list.locator('li.voting-item[data-uuid="false"]').click();
            }
            await page.locator('#confirm-vote-btn').click();
        }

        // Last wolf dead -> the village wins and every role is revealed.
        for (const phone of phones) {
            await expect(phone.page.locator('#winner-team-text')).toHaveText('The Village Wins!');
            await expect(phone.page.locator('#final-roles-list li.final-role-item')).toHaveCount(4);
        }

        for (let i = 0; i < phones.length; i++) {
            const row = gm.locator('#final-roles-list li.final-role-item').filter({ hasText: nameOf(i) });
            await expect(row).toHaveCount(1);
            await expect(row).toContainText(game.roles[i]!);
        }

        await expect(phones[wolfIndex]!.page.locator('#player-status-text')).toHaveText('You lost!');
        const villageWinner = [...phones.keys()].find((index) => index !== wolfIndex)!;
        await expect(phones[villageWinner]!.page.locator('#player-status-text')).toHaveText('You won!');

        // The overlay must be dismissed before the way home is tappable.
        for (const phone of phones) await dismissDeathPopup(phone.page);

        await expect(gm.locator('#back-to-lobby-btn')).toBeVisible();
        await gm.locator('#back-to-lobby-btn').click();
        await expect(gm).toHaveURL(/#\/$/);
        await expect(gm.locator('#create-game')).toBeVisible();
    });

    test('a full 10-player lobby: every name is reachable and nothing scrolls sideways', async ({ browser }) => {
        test.slow();

        const lobby = await openLobby(browser, 10);
        phones = lobby.phones;
        watch(phones);
        const gm = lobby.gm;

        for (let index = 1; index < 10; index++) {
            await expect(gm.locator('#lobby-players-list')).toContainText(nameOf(index));
        }
        // The list hides your own seat, so the GM sees the other nine.
        await expect(gm.locator('#lobby-players-list li')).toHaveCount(9);

        // A long lobby has to be scrollable: the last row must be brought into view.
        expect(await gm.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)).toBe(true);
        const lastRow = gm.locator('#lobby-players-list li').filter({ hasText: 'Player 9' });
        await expect(lastRow).toHaveCount(1);
        await lastRow.scrollIntoViewIfNeeded();
        await expect(lastRow).toBeInViewport();

        for (const checked of [gm, phones[9]!.page]) {
            expect(await pageOverflow(checked), 'the lobby must not overflow horizontally').toBeLessThanOrEqual(1);
        }
    });

    test('a 40-character name does not break the lobby or the day list', async ({ browser }) => {
        test.slow();

        const LONG_NAME = 'MaximilianvonHinterwaldhausenmeisterIIII';
        expect(LONG_NAME).toHaveLength(40);

        // The name has to be set in the lobby, before the game starts, so it is present
        // in both the lobby list and the day's lists later on.
        const lobby = await openLobby(browser, 4);
        phones = lobby.phones;
        watch(phones);
        const gm = lobby.gm;
        await setName(gm, LONG_NAME);

        for (const phone of phones.slice(1)) {
            await expect(phone.page.locator('#lobby-players-list')).toContainText(LONG_NAME);
        }
        for (const page of [gm, phones[1]!.page]) {
            expect(await pageOverflow(page), 'a long name must not widen the lobby').toBeLessThanOrEqual(1);
        }
        expect(await rowOverflow(phones[1]!.page, '#lobby-players-list', LONG_NAME)).toBeLessThanOrEqual(1);

        await closeJoining(gm);
        await startActualGame(gm);
        for (const phone of phones) await waitForNight(phone.page);

        await advanceUntilVisibleOn(lobby, '#day-nomination-view', 14);
        const dayList = phones[1]!.page;
        await expect(dayList.locator('#day-nomination-list')).toContainText(LONG_NAME);
        expect(await pageOverflow(dayList), 'a long name must not widen the day screen').toBeLessThanOrEqual(1);
        expect(await rowOverflow(dayList, '#day-nomination-list', LONG_NAME)).toBeLessThanOrEqual(1);
    });
});
