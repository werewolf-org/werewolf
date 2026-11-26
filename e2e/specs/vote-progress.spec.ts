import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
    closePhones,
    collectPageErrors,
    failOnDialogs,
    isVisible,
    nominate,
    startGameWithPlayers,
    voteToLynch,
    waitUntilVisible,
} from '../lib/flows';
import type { Phone } from '../lib/flows';

// Who has decided is public; what they chose is not. The trial stage used to show a bare
// count, which answers "how far along are we" but not "who do we have to poke". This pins the
// names on screen, including the "you" wording when the phone holding it is the blocker, and
// that an abstain counts as decided.

const nameOf = (index: number): string => (index === 0 ? 'Gamemaster' : `Player ${index}`);

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

async function advanceUntilVisible(gm: Page, selector: string, maxSteps = 16): Promise<void> {
    for (let step = 0; step < maxSteps; step++) {
        if (await isVisible(gm, selector)) return;
        if (await isVisible(gm, '#death-popup-overlay')) {
            await gm.locator('#close-death-popup').click();
            await expect(gm.locator('#death-popup-overlay')).toBeHidden();
        }
        await advanceOnce(gm);
    }
    await waitUntilVisible(gm, selector);
}

test.describe('vote progress', () => {
    let phones: Phone[] = [];
    let pageErrors: string[] = [];
    let dialogs: string[] = [];

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

    test('the trial names who is still deciding, and an abstain counts as decided', async ({ browser }) => {
        test.slow();

        const game = await startGameWithPlayers(browser, 5);
        phones = game.phones;
        for (const phone of phones) {
            collectPageErrors(phone.page, pageErrors);
            failOnDialogs(phone.page, dialogs);
        }

        await advanceUntilVisible(game.gm, '#day-nomination-view');

        // One candidate on the ballot: Player 2, nominated by Player 1.
        const targetIndex = 2;
        const targetName = nameOf(targetIndex);
        await nominate(phones[1]!.page, targetName);
        for (const index of [0, 2, 3, 4]) await nominate(phones[index]!.page, null);
        for (const phone of phones) await expect(phone.page.locator('#day-voting-view')).toBeVisible();

        // Nobody has voted. The phone holding the blocker is told so directly.
        const watcher = phones[4]!.page;
        await expect(watcher.locator('#vote-progress')).toHaveText('0 of 5 decided');
        await expect(watcher.locator('#vote-waiting')).toHaveText('Waiting for you, Gamemaster, Player 1, Player 2 and Player 3.');

        // One ballot. Everyone can see that Player 1 is done, nobody can see what they chose.
        await voteToLynch(phones[1]!.page, targetName);
        await expect(watcher.locator('#vote-progress')).toHaveText('1 of 5 decided');
        await expect(watcher.locator('#vote-waiting')).toHaveText('Waiting for you, Gamemaster, Player 2 and Player 3.');
        await expect(watcher.locator('#day-vote-list')).toContainText(targetName);

        // The voter sees the same names, phrased as a status rather than an instruction.
        const voter = phones[1]!.page;
        await expect(voter.locator('#vote-confirmed-message')).toContainText(`You voted for ${targetName}.`);
        await expect(voter.locator('#vote-confirmed-message')).toContainText('Waiting for Gamemaster, Player 2, Player 3 and Player 4.');
        await expect(voter.locator('#vote-confirmed-message')).not.toContainText('Player 1');

        // An abstain is a decision, and the next blocker drops off the list.
        await voteToLynch(phones[3]!.page, null);
        await expect(watcher.locator('#vote-progress')).toHaveText('2 of 5 decided');
        await expect(watcher.locator('#vote-waiting')).toHaveText('Waiting for you, Gamemaster and Player 2.');

        // No rejection, no toast: this is normal conversation, not an error path.
        for (const phone of phones) await expect(phone.page.locator('#game-toast')).toBeHidden();
    });
});
