import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
    closePhones,
    collectPageErrors,
    failOnDialogs,
    isVisible,
    nominate,
    startGameWithPlayers,
    waitUntilHidden,
    waitUntilVisible,
} from '../lib/flows';
import type { Phone } from '../lib/flows';

// The daily nomination stage as a phone shows it. Three contracts live here:
//
//  1. One list of every living player. There is no separate "available" list and no
//     "Nominate No One" pseudo-player: passing is its own button, outside the list.
//  2. Agreeing with a nomination is a legal action. The row stays tappable, the confirm
//     button says "Nominate X too", and nothing is rejected. The trial ballot still lists
//     the candidate once.
//  3. Progress is by name ("waiting for Ben"), because that is what a table needs when a
//     phone has gone quiet.

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

async function dismissDeathPopup(page: Page): Promise<void> {
    if (!(await isVisible(page, '#death-popup-overlay'))) return;
    await page.locator('#close-death-popup').click();
    await waitUntilHidden(page, '#death-popup-overlay');
}

async function advanceUntilVisible(gm: Page, selector: string, maxSteps = 16): Promise<void> {
    for (let step = 0; step < maxSteps; step++) {
        if (await isVisible(gm, selector)) return;
        await dismissDeathPopup(gm);
        await advanceOnce(gm);
    }
    await waitUntilVisible(gm, selector);
}

test.describe('nominations', () => {
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

    test('one list, a second is legal, and the count names the players still deciding', async ({ browser }) => {
        test.slow();

        const game = await startGameWithPlayers(browser, 5);
        phones = game.phones;
        watch(phones);
        const gm = game.gm;

        await advanceUntilVisible(gm, '#day-nomination-view');
        for (const phone of phones) await expect(phone.page.locator('#day-nomination-view')).toBeVisible();

        const targetIndex = 2;
        const targetName = nameOf(targetIndex);
        const first = phones[1]!.page;

        // The consequence of passing is on screen, not hidden in a button label.
        await expect(first.locator('#day-nomination-view')).toContainText(
            'If nobody is nominated, the day ends without a lynch.',
        );

        // One list: every living player, including the GM (who is also a player) and the
        // player viewing it. Nothing is split into a second "available" list.
        const list = first.locator('#day-nomination-list');
        await expect(list.locator('li.nomination-item')).toHaveCount(5);
        await expect(list).toContainText(nameOf(0));
        await expect(list).toContainText(`${nameOf(1)} (You)`);
        await expect(first.locator('#day-nomination-view')).not.toContainText('Nominate No One');

        // First nomination of the candidate.
        await first.locator('#day-nomination-list li.nomination-item').filter({ hasText: targetName }).click();
        await expect(first.locator('#confirm-nomination-btn')).toHaveText(`Nominate ${targetName}`);
        await first.locator('#confirm-nomination-btn').click();
        await expect(first.locator('#nomination-confirmed-message')).toContainText(`You nominated ${targetName}`);

        // Second nomination of the SAME candidate, from another phone: legal, explained,
        // and labelled. This is the interaction that used to be a dead end.
        const second = phones[3]!.page;
        const secondRow = second.locator('#day-nomination-list li.nomination-item').filter({ hasText: targetName });
        await expect(secondRow).toContainText('On trial');
        await secondRow.click();
        await expect(second.locator('#nomination-selection-hint')).toContainText('is already on trial');
        await expect(second.locator('#confirm-nomination-btn')).toHaveText(`Nominate ${targetName} too`);
        await second.locator('#confirm-nomination-btn').click();
        await expect(second.locator('#nomination-confirmed-message')).toContainText(`You nominated ${targetName}`);

        // The chip counts both, and the card stays on the same screen (no rejection, no toast).
        await expect(
            first.locator('#day-nomination-list li.nomination-item').filter({ hasText: targetName }),
        ).toContainText('On trial · 2');
        await expect(first.locator('#game-toast')).toBeHidden();

        // Progress is by name. Gamemaster, Player 2 (the candidate) and Player 4 have not decided.
        const third = phones[4]!.page;
        await expect(third.locator('#nomination-progress')).toHaveText('2 of 5 decided');
        await expect(third.locator('#nomination-waiting')).toContainText('Waiting for');
        await expect(third.locator('#nomination-waiting')).toContainText(nameOf(0));
        await expect(third.locator('#nomination-waiting')).toContainText(nameOf(2));
        await expect(third.locator('#nomination-waiting')).toContainText(nameOf(4));

        // Everyone else passes via the button outside the list.
        for (const index of [0, 2, 4]) {
            await nominate(phones[index]!.page, null);
        }

        // The trial ballot lists the seconded candidate once and names both nominators.
        for (const phone of phones) await expect(phone.page.locator('#day-voting-view')).toBeVisible();
        const ballot = third.locator('#day-vote-list li.voting-item').filter({ hasText: targetName });
        await expect(ballot).toHaveCount(1);
        await expect(ballot).toContainText(`Nominated by ${nameOf(1)} and ${nameOf(3)}`);
    });

    test('passing every nomination ends the day without a trial', async ({ browser }) => {
        test.slow();

        const game = await startGameWithPlayers(browser, 4);
        phones = game.phones;
        watch(phones);

        await advanceUntilVisible(game.gm, '#day-nomination-view');

        // "No nomination" is a selection plus the same confirm button as a name, so a
        // mis-tap cannot submit on its own. Tapping it again would deselect it, which is
        // why this phone confirms directly instead of going through the `nominate` helper.
        const first = phones[0]!.page;
        await first.locator('#no-nomination-btn').click();
        await expect(first.locator('#no-nomination-btn')).toHaveClass(/selected/);
        await expect(first.locator('#confirm-nomination-btn')).toHaveText('Confirm no nomination');
        await expect(first.locator('#nomination-selection-hint')).toContainText('still vote in the trial');
        await first.locator('#confirm-nomination-btn').click();

        for (const phone of phones.slice(1)) {
            await nominate(phone.page, null);
        }

        // Nobody nominated: the day resolves straight to the result, never to a trial.
        for (const phone of phones) {
            await expect(phone.page.locator('#day-result-view')).toBeVisible();
            await expect(phone.page.locator('#day-voting-view')).toBeHidden();
            await expect(phone.page.locator('#lynched-player-name')).toHaveText('No One');
        }
    });
});
