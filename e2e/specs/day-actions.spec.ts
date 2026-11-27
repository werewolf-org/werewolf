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
    waitForNight,
    waitUntilHidden,
    waitUntilVisible,
} from '../lib/flows';
import type { Phone } from '../lib/flows';

// The day is the longest screen in the game and the one with the most rows, so it is where
// the action bar fell off a phone first: with five or more players the confirm button sat
// below the fold and the only way to act was to scroll past the roster. Sticky is the fix;
// these tests pin it to the viewport without scrolling and prove the content behind it is
// genuinely taller than the screen (otherwise "the button is visible" would be true for the
// wrong reason).
//
// The second contract: the end-of-day confirm is participation, like a ballot. Once the lynch
// is resolved, every phone sees how many are ready and which names are missing, including the
// dead, who are not asked but are still watching.

const nameOf = (index: number): string => (index === 0 ? 'Gamemaster' : `Player ${index}`);

/** "Ben, Clara and Deniz", the sentence form the app uses for a named list. */
const sentence = (names: string[]): string => {
    if (names.length <= 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

/**
 * A lynched villager, so the game continues into the result stage. The composition at five
 * players is one werewolf, three villagers and a seer; the GM is never chosen as the body.
 */
function safeVictim(roles: string[]): number {
    const index = roles.findIndex((role, position) => position > 0 && role === 'Villager');
    if (index < 0) throw new Error(`no non-GM villager in this deal: ${roles.join(', ')}`);
    return index;
}

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

/**
 * The button has to be fully on screen on a phone that has not scrolled at all. Start the
 * stage at the top first: an earlier stage can leave the page scrolled (typing a name in the
 * lobby scrolls the input into view), and that is not the screen under test. With the page at
 * the top, a button below the fold is exactly the bug this fixes.
 */
async function expectActionBarInViewport(page: Page, selector: string): Promise<void> {
    await page.evaluate(() => window.scrollTo(0, 0));

    const locator = page.locator(selector);
    await expect(locator).toBeVisible();
    await expect(locator).toBeInViewport({ ratio: 1 });

    const box = await locator.boundingBox();
    const viewport = page.viewportSize();
    expect(box, `${selector} has no box`).not.toBeNull();
    expect(viewport, 'the phone has no viewport size').not.toBeNull();
    expect(box!.y, `${selector} starts above the screen`).toBeGreaterThanOrEqual(-1);
    expect(box!.y + box!.height, `${selector} ends below the fold`).toBeLessThanOrEqual(viewport!.height + 1);
    expect(await page.evaluate(() => window.scrollY), 'the phone should not have to scroll').toBe(0);
}

test.describe('day action bar', () => {
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

    test('the nomination, ballot and ready buttons stay on screen without scrolling', async ({ browser }) => {
        test.slow();

        const game = await startGameWithPlayers(browser, 5);
        phones = game.phones;
        for (const phone of phones) {
            collectPageErrors(phone.page, pageErrors);
            failOnDialogs(phone.page, dialogs);
        }
        const victimName = nameOf(safeVictim(game.roles));

        await advanceUntilVisible(game.gm, '#day-nomination-view');

        // A crowded day: the roster alone pushes the page past the screen. If this were not
        // true, "the button is visible" would be true for the wrong reason.
        const watcher = phones[4]!.page;
        const scrolls = await watcher.evaluate(
            () => document.documentElement.scrollHeight > window.innerHeight,
        );
        expect(scrolls, 'this test only proves something if the day screen is taller than the phone').toBe(true);

        // Nominations: the bar is on screen before the phone has touched the page.
        await expectActionBarInViewport(watcher, '#confirm-nomination-btn');
        await expect(watcher.locator('#confirm-nomination-btn')).toBeDisabled();

        // Selecting a name re-renders the button with a new label; it must not fall off.
        const firstRow = watcher.locator('#day-nomination-list li.nomination-item').filter({ hasText: victimName });
        await expect(firstRow).toHaveCount(1);
        await firstRow.click();
        await expect(watcher.locator('#confirm-nomination-btn')).toBeEnabled();
        await expectActionBarInViewport(watcher, '#confirm-nomination-btn');
        await watcher.locator('#confirm-nomination-btn').click();
        await expect(watcher.locator('#nomination-confirmed-message')).toBeVisible();

        // The rest of the table passes, which leaves one candidate on the trial ballot.
        for (const index of [0, 1, 2, 3]) await nominate(phones[index]!.page, null);
        for (const phone of phones) await expect(phone.page.locator('#day-voting-view')).toBeVisible();

        // The ballot is selected exactly like a nomination, so the same guarantee applies.
        await expectActionBarInViewport(watcher, '#confirm-vote-btn');
        const target = watcher.locator('#day-vote-list li.voting-item').filter({ hasText: victimName });
        await expect(target).toHaveCount(1);
        await target.click();
        await expect(watcher.locator('#confirm-vote-btn')).toBeEnabled();
        await expectActionBarInViewport(watcher, '#confirm-vote-btn');
        await watcher.locator('#confirm-vote-btn').click();

        // Everyone else votes so the lynch resolves and the result stage opens.
        for (const index of [0, 1, 2, 3]) await voteToLynch(phones[index]!.page, victimName);
        for (const phone of phones) {
            await dismissDeathPopup(phone.page);
            await expect(phone.page.locator('#day-result-view')).toBeVisible();
        }

        // The result stage is the longest one and its button is the last one of the day.
        // The GM is always alive: the body above is a non-GM villager.
        await expectActionBarInViewport(game.gm, '#ready-for-night-btn');
    });

    test('ready for night names the phones that have not confirmed, for everyone', async ({ browser }) => {
        test.slow();

        const game = await startGameWithPlayers(browser, 5);
        phones = game.phones;
        for (const phone of phones) {
            collectPageErrors(phone.page, pageErrors);
            failOnDialogs(phone.page, dialogs);
        }
        const victimIndex = safeVictim(game.roles);
        const victimName = nameOf(victimIndex);

        await advanceUntilVisible(game.gm, '#day-nomination-view');

        // One candidate, then a unanimous lynch. The body is a villager, so the game goes on.
        await nominate(phones[1]!.page, victimName);
        for (const index of [0, 2, 3, 4]) await nominate(phones[index]!.page, null);
        for (const phone of phones) await expect(phone.page.locator('#day-voting-view')).toBeVisible();
        for (const phone of phones) await voteToLynch(phone.page, victimName);
        for (const phone of phones) {
            await dismissDeathPopup(phone.page);
            await expect(phone.page.locator('#day-result-view')).toBeVisible();
        }

        // The victim is dead and is not asked. The four living phones are.
        const alive = phones.map((_, index) => index).filter(index => index !== victimIndex);
        const watcherIndex = [4, 3, 2, 1].find(index => index !== victimIndex)!;
        const watcher = phones[watcherIndex]!.page;
        const watcherOthers = alive.filter(index => index !== watcherIndex).map(nameOf);

        await expect(watcher.locator('#ready-progress')).toHaveText('0 of 4 ready');
        await expect(watcher.locator('#ready-waiting')).toHaveText(`Waiting for you, ${sentence(watcherOthers)}.`);

        // One phone confirms. Nobody can see a choice, because there is none to see: this is
        // only "who has tapped", which is exactly what a stuck table needs.
        const firstReadyIndex = alive.find(index => index !== watcherIndex)!;
        const firstReady = phones[firstReadyIndex]!.page;
        await firstReady.locator('#ready-for-night-btn').click();

        const stillMissingForWatcher = alive
            .filter(index => index !== watcherIndex && index !== firstReadyIndex)
            .map(nameOf);
        await expect(watcher.locator('#ready-progress')).toHaveText('1 of 4 ready');
        await expect(watcher.locator('#ready-waiting')).toHaveText(`Waiting for you, ${sentence(stillMissingForWatcher)}.`);

        // The phone that already confirmed sees the same list, phrased as a status.
        const missingForFirstReady = alive.filter(index => index !== firstReadyIndex).map(nameOf);
        await expect(firstReady.locator('#day-result-controls')).toBeHidden();
        await expect(firstReady.locator('#night-waiting-message')).toBeVisible();
        await expect(firstReady.locator('#night-waiting-names')).toHaveText(`Waiting for ${sentence(missingForFirstReady)}.`);

        // The dead are not asked, but they are not blind either.
        const deadPhone = phones[victimIndex]!.page;
        await expect(deadPhone.locator('#ready-for-night-btn')).toBeHidden();
        await expect(deadPhone.locator('#ready-progress')).toHaveText('1 of 4 ready');
        await expect(deadPhone.locator('#ready-waiting')).toHaveText(`Waiting for ${sentence(missingForFirstReady)}.`);

        // The remaining living phones release the night.
        for (const index of alive) {
            if (index === firstReadyIndex) continue;
            await phones[index]!.page.locator('#ready-for-night-btn').click();
        }
        for (const phone of phones) await waitForNight(phone.page);

        for (const phone of phones) await expect(phone.page.locator('#game-toast')).toBeHidden();
    });
});
