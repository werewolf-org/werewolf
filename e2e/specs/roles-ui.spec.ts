import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
    closePhones,
    collectPageErrors,
    failOnDialogs,
    isVisible,
    startGameWithPlayers,
    waitUntilHidden,
    waitUntilVisible,
} from '../lib/flows';
import type { Phone, StartedGame } from '../lib/flows';

// Every role that wakes at night, driven from the phone that was actually dealt that
// role. The deal is random, so every seat is found through `game.roles`; nothing here
// assumes who sits where. Where the rules matter (the Red Lady dying with her host) the
// assertion follows backend/src/logic/handlers/night.handler.ts, not the rule text.

const SLEEP_TEXT = 'Close your eyes…'; // U+2026, copied from night.html

const nameOf = (index: number): string => (index === 0 ? 'Gamemaster' : `Player ${index}`);

const indexesOf = (game: StartedGame, role: string): number[] =>
    game.roles.flatMap((dealt, index) => (dealt === role ? [index] : []));

/**
 * One stage of the GM escape hatch: arm, confirm, and wait until the button is re-armed.
 * A freshly arrived snapshot is the only proof that the step landed, so callers never
 * read a screen from before the advance (same contract as the gameplay spec).
 */
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

/** A death announcement is a full-screen overlay: it would swallow the GM's next tap. */
async function dismissDeathPopup(page: Page): Promise<void> {
    if (!(await isVisible(page, '#death-popup-overlay'))) return;
    await page.locator('#close-death-popup').click();
    await waitUntilHidden(page, '#death-popup-overlay');
}

/** Advance one stage with the popup bookkeeping the GM needs to keep tapping. */
async function advance(game: StartedGame): Promise<void> {
    await dismissDeathPopup(game.gm);
    await advanceOnce(game.gm);
    await dismissDeathPopup(game.gm);
}

/** Advance (nights, sheriff election and day all included) until `done` holds. */
async function advanceUntil(game: StartedGame, done: () => Promise<boolean>, maxSteps = 16): Promise<void> {
    for (let step = 0; step < maxSteps; step++) {
        if (await done()) return;
        await advance(game);
    }
    expect(await done(), 'the game never reached the expected screen').toBe(true);
}

async function advanceUntilVisibleOn(game: StartedGame, selector: string, maxSteps = 16): Promise<void> {
    await advanceUntil(game, () => isVisible(game.gm, selector), maxSteps);
}

/** Advance until `role`'s own action UI is on screen. Returns the seat that woke. */
async function advanceToRole(game: StartedGame, role: string, maxSteps = 14): Promise<number> {
    const candidates = indexesOf(game, role);
    if (candidates.length === 0) throw new Error(`role ${role} is not in this game: ${game.roles.join(', ')}`);

    let woke = -1;
    await advanceUntil(
        game,
        async () => {
            for (const index of candidates) {
                if (await isVisible(game.phones[index]!.page, '#night-action-container')) {
                    woke = index;
                    return true;
                }
            }
            return false;
        },
        maxSteps,
    );
    return woke;
}

/**
 * From the end of a night (sheriff election or day), walk the quiet stage endings and
 * land on the first role of the next night: fill nominations, resolve the empty lynch,
 * start the night.
 */
async function advanceIntoNextNight(game: StartedGame): Promise<void> {
    await advanceUntilVisibleOn(game, '#day-nomination-view', 12);
    // An empty nomination stage finishes in one GM step (nothing to nominate, so the
    // lynch is resolved as "nobody"), and the second step starts the night.
    for (let step = 0; step < 2; step++) await advance(game);
    await waitUntilHidden(game.gm, '#day-nomination-view');
}

async function voteAsWolf(game: StartedGame, wolfIndex: number, targetName: string): Promise<void> {
    const page = game.phones[wolfIndex]!.page;
    await waitUntilVisible(page, '#werewolf-target-list');
    const target = page.locator('#werewolf-target-list li.selectable-player').filter({ hasText: targetName });
    await expect(target, `${nameOf(wolfIndex)} cannot pick ${targetName}`).toHaveCount(1);
    await target.click();
    await expect(target).toHaveClass(/selected/);
    await page.locator('#confirm-werewolf-target-btn').click();
}

test.describe('roles-ui', () => {
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

    test('witch (heal): sees the wolf victim, heals once, and the heal is gone next night', async ({ browser }) => {
        test.slow();

        // 6 players deals two wolves, a seer and a witch: the wolves can agree on one
        // victim, which is the precondition for the healing potion.
        const game = await startGameWithPlayers(browser, 6);
        phones = game.phones;
        watch(phones);

        const wolves = indexesOf(game, 'Werewolf');
        expect(wolves, `the 6-player preset must deal two wolves, got ${game.roles.join(', ')}`).toHaveLength(2);
        const victimIndex = game.roles.indexOf('Villager');
        const witchIndex = game.roles.indexOf('Witch');
        const seerIndex = game.roles.indexOf('Seer');
        expect(victimIndex).toBeGreaterThanOrEqual(0);
        expect(witchIndex).toBeGreaterThanOrEqual(0);
        expect(seerIndex).toBeGreaterThanOrEqual(0);
        const victimName = nameOf(victimIndex);

        await voteAsWolf(game, wolves[0]!, victimName);
        await expect(phones[wolves[0]!]!.page.locator('#werewolf-waiting-message')).toBeVisible();
        await voteAsWolf(game, wolves[1]!, victimName);

        // One agreed victim moves the night on to the seer.
        await waitUntilVisible(phones[seerIndex]!.page, '#seer-target-list');
        await advance(game);

        const witch = phones[witchIndex]!.page;
        await waitUntilVisible(witch, '#night-action-container');
        await expect(witch.locator('#witch-victim-reveal')).toHaveText(victimName);
        await expect(witch.locator('#use-heal-btn')).toBeEnabled();

        await witch.locator('#use-heal-btn').click();
        await waitUntilHidden(witch, '#heal-controls');
        await expect(witch.locator('#heal-used-msg')).toBeVisible();
        await expect(witch.locator('#heal-used-msg')).toHaveText('Potion used tonight.');
        await expect(witch.locator('#use-heal-btn')).toBeHidden();

        await witch.locator('#confirm-witch-actions-btn').click();
        await waitUntilVisible(witch, '#sheriff-voting-view');
        expect(await isVisible(witch, '#night-action-container')).toBe(false);
        await expect(witch.locator('#use-heal-btn')).toHaveCount(0);

        // Next night: the same seat wakes as the witch, but the potion is spent for good.
        await advanceIntoNextNight(game);
        expect(await advanceToRole(game, 'Witch')).toBe(witchIndex);
        await waitUntilVisible(witch, '#night-action-container');
        await expect(witch.locator('#heal-used-msg')).toBeVisible();
        await expect(witch.locator('#heal-used-msg')).toHaveText('Potion already used.');
        await expect(witch.locator('#use-heal-btn')).toBeHidden();
    });

    test('witch (kill): selecting is free, confirming spends the potion, and it never comes back', async ({ browser }) => {
        test.slow();

        const game = await startGameWithPlayers(browser, 6);
        phones = game.phones;
        watch(phones);

        const witchIndex = game.roles.indexOf('Witch');
        expect(witchIndex).toBeGreaterThanOrEqual(0);
        const victimIndex = game.roles.indexOf('Villager');
        // Poison the other villager: heal + kill on the same player is rejected by the
        // backend, so the two potions need two different targets.
        const poisonIndex = game.roles.findIndex(
            (role, index) => index !== 0 && role === 'Villager' && index !== victimIndex,
        );
        expect(poisonIndex).toBeGreaterThanOrEqual(0);
        const poisonName = nameOf(poisonIndex);

        // No wolf vote at all: the witch sees a peaceful night, and the heal is unusable.
        await advanceToRole(game, 'Witch');
        const witch = phones[witchIndex]!.page;
        await waitUntilVisible(witch, '#night-action-container');
        await expect(witch.locator('#witch-victim-reveal')).toHaveText('No One');
        await expect(witch.locator('#use-heal-btn')).toBeDisabled();

        await witch.locator('#use-kill-btn').click();
        await expect(witch.locator('#witch-kill-selection')).toBeVisible();

        const target = witch.locator('#witch-kill-list li.selectable-player').filter({ hasText: poisonName });
        await expect(target).toHaveCount(1);
        await target.click();
        await expect(target).toHaveClass(/selected/);

        // A selection alone changes nothing: the potion is still unspent...
        await expect(witch.locator('#kill-controls')).toBeVisible();
        await expect(witch.locator('#kill-used-msg')).toBeHidden();
        await expect(witch.locator('#confirm-kill-btn')).toBeEnabled();

        // ...and only the deliberate confirm burns it.
        await witch.locator('#confirm-kill-btn').click();
        await waitUntilHidden(witch, '#kill-controls');
        await expect(witch.locator('#witch-kill-selection')).toBeHidden();
        await expect(witch.locator('#kill-used-msg')).toHaveText('Potion used tonight.');
        await expect(witch.locator('#use-kill-btn')).toBeHidden();

        await witch.locator('#confirm-witch-actions-btn').click();
        // The poison resolves at dawn and is announced to everyone.
        const dead = phones[poisonIndex]!.page;
        await waitUntilVisible(dead, '#death-popup-overlay');
        await expect(dead.locator('#newly-dead-list')).toContainText(poisonName);
        await expect(dead.locator('#newly-dead-list')).toContainText('Villager');
        for (const phone of phones) await dismissDeathPopup(phone.page);

        await advanceIntoNextNight(game);
        expect(await advanceToRole(game, 'Witch')).toBe(witchIndex);
        await waitUntilVisible(witch, '#night-action-container');
        await expect(witch.locator('#kill-controls')).toBeHidden();
        await expect(witch.locator('#kill-used-msg')).toHaveText('Potion already used.');
        await expect(witch.locator('#use-kill-btn')).toBeHidden();
    });

    test('witch: both potions in one night, each spendable only once, and nothing outside her turn', async ({ browser }) => {
        test.slow();

        const game = await startGameWithPlayers(browser, 6);
        phones = game.phones;
        watch(phones);

        const wolves = indexesOf(game, 'Werewolf');
        expect(wolves).toHaveLength(2);
        const victimIndex = game.roles.indexOf('Villager');
        const witchIndex = game.roles.indexOf('Witch');
        const seerIndex = game.roles.indexOf('Seer');
        expect(victimIndex).toBeGreaterThanOrEqual(0);
        expect(witchIndex).toBeGreaterThanOrEqual(0);
        expect(seerIndex).toBeGreaterThanOrEqual(0);
        const victimName = nameOf(victimIndex);

        await voteAsWolf(game, wolves[0]!, victimName);
        await voteAsWolf(game, wolves[1]!, victimName);
        await waitUntilVisible(phones[seerIndex]!.page, '#seer-target-list');
        await advance(game);

        const witch = phones[witchIndex]!.page;
        await waitUntilVisible(witch, '#witch-victim-reveal');
        await expect(witch.locator('#witch-victim-reveal')).toHaveText(victimName);

        // Heal first. The affordance has to disappear immediately: a second tap must
        // not be able to spend the one-shot potion again.
        await witch.locator('#use-heal-btn').click();
        await waitUntilHidden(witch, '#heal-controls');
        await expect(witch.locator('#heal-used-msg')).toHaveText('Potion used tonight.');
        await expect(witch.locator('#use-heal-btn')).toBeHidden();

        // Killing is still untouched, and it poisons a different player.
        await expect(witch.locator('#use-kill-btn')).toBeVisible();
        const poisonIndex = game.roles.findIndex(
            (role, index) => index !== 0 && index !== victimIndex && index !== witchIndex && role === 'Villager',
        );
        expect(poisonIndex).toBeGreaterThanOrEqual(0);
        await witch.locator('#use-kill-btn').click();
        const poison = witch.locator('#witch-kill-list li.selectable-player').filter({ hasText: nameOf(poisonIndex) });
        await expect(poison).toHaveCount(1);
        await poison.click();
        await witch.locator('#confirm-kill-btn').click();
        await waitUntilHidden(witch, '#kill-controls');

        // Both potions are marked spent, side by side, on the same night.
        await expect(witch.locator('#heal-used-msg')).toHaveText('Potion used tonight.');
        await expect(witch.locator('#kill-used-msg')).toHaveText('Potion used tonight.');
        await expect(witch.locator('#heal-controls')).toBeHidden();
        await expect(witch.locator('#kill-controls')).toBeHidden();

        // Confirming ends her sub-turn; the witch screens are torn down with it.
        await witch.locator('#confirm-witch-actions-btn').click();
        await waitUntilVisible(witch, '#sheriff-voting-view');
        expect(await isVisible(witch, '#night-action-container')).toBe(false);
        await expect(witch.locator('#use-heal-btn')).toHaveCount(0);
        await expect(witch.locator('#use-kill-btn')).toHaveCount(0);
        await expect(witch.locator('#confirm-witch-actions-btn')).toHaveCount(0);
    });

    test('seer: reveals one real role, dismisses it, and cannot look again that night', async ({ browser }) => {
        test.slow();

        const game = await startGameWithPlayers(browser, 6);
        phones = game.phones;
        watch(phones);

        const seerIndex = game.roles.indexOf('Seer');
        expect(seerIndex).toBeGreaterThanOrEqual(0);
        const targetIndex = game.roles.findIndex(
            (role, index) => index !== seerIndex && (role === 'Werewolf' || role === 'Villager'),
        );
        expect(targetIndex).toBeGreaterThanOrEqual(0);
        const targetName = nameOf(targetIndex);
        const targetRole = game.roles[targetIndex]!;

        // Night starts with the wolves; one skipped stage opens the seer's eye.
        await advanceToRole(game, 'Seer');
        const seer = phones[seerIndex]!.page;
        await waitUntilVisible(seer, '#seer-target-list');

        const target = seer.locator('#seer-target-list li.selectable-player').filter({ hasText: targetName });
        await expect(target).toHaveCount(1);
        await target.click();
        await expect(target).toHaveClass(/selected/);
        await seer.locator('#confirm-seer-target-btn').click();

        await waitUntilVisible(seer, '#seer-reveal-view');
        await expect(seer.locator('#reveal-role-name')).toHaveText(targetRole);
        await expect(seer.locator('#reveal-player-name')).toContainText(targetName);

        await seer.locator('#dismiss-reveal-btn').click();

        // The next role wakes; the seer's selection UI is gone for this night.
        await waitUntilVisible(seer, '#night-sleep-view');
        expect(await isVisible(seer, '#seer-target-list')).toBe(false);
        await expect(seer.locator('#seer-target-list')).toHaveCount(0);
        await expect(seer.locator('#confirm-seer-target-btn')).toHaveCount(0);
        expect(await isVisible(seer, '#night-action-container')).toBe(false);
    });

    test('cupid: binds two players who each see and accept their partner; a lover can never bind', async ({ browser }) => {
        test.slow();

        // The Cupid only exists from 7 players up.
        const game = await startGameWithPlayers(browser, 7);
        phones = game.phones;
        watch(phones);

        const cupidIndex = game.roles.indexOf('Cupid');
        expect(cupidIndex, `the 7-player preset must deal a Cupid, got ${game.roles.join(', ')}`).toBeGreaterThanOrEqual(0);
        const lovers = game.roles.flatMap((role, index) => (role === 'Villager' ? [index] : []));
        expect(lovers).toHaveLength(2);
        const [firstIndex, secondIndex] = lovers as [number, number];
        const cupid = phones[cupidIndex]!.page;

        // Night one starts with Cupid.
        await waitUntilVisible(cupid, '#cupid-selection-view');
        await expect(cupid.locator('#cupid-target-list li.selectable-player')).toHaveCount(7);
        await cupid.locator('#cupid-target-list li.selectable-player').filter({ hasText: nameOf(firstIndex) }).click();
        await expect(cupid.locator('#cupid-selection-count')).toHaveText('1 / 2 Selected');
        await cupid.locator('#cupid-target-list li.selectable-player').filter({ hasText: nameOf(secondIndex) }).click();
        await expect(cupid.locator('#cupid-selection-count')).toHaveText('2 / 2 Selected');
        await cupid.locator('#confirm-cupid-target-btn').click();

        // The cupid watches the two lovers wake up.
        await waitUntilVisible(cupid, '#cupid-status-view');
        await expect(cupid.locator('#lover-status-list')).toContainText(nameOf(firstIndex));
        await expect(cupid.locator('#lover-status-list')).toContainText(nameOf(secondIndex));
        await expect(cupid.locator('#cupid-selection-view')).toBeHidden();

        const first = phones[firstIndex]!.page;
        const second = phones[secondIndex]!.page;
        for (const [page, partner] of [
            [first, nameOf(secondIndex)],
            [second, nameOf(firstIndex)],
        ] as const) {
            await waitUntilVisible(page, '#lovers-view');
            await expect(page.locator('#partner-name')).toHaveText(partner);
            // A lover gets the bond screen, never Cupid's selection screen: the list is
            // empty and the archery controls are hidden.
            await expect(page.locator('#cupid-selection-view')).toBeHidden();
            await expect(page.locator('#cupid-target-list li')).toHaveCount(0);
            await expect(page.locator('#confirm-cupid-target-btn')).toBeHidden();
        }

        // Before anybody accepts, the sealed line exists in the hidden sleep view but is
        // not shown to the Cupid.
        expect(await isVisible(cupid, '#night-cupid-sealed')).toBe(false);

        await first.locator('#confirm-love-btn').click();
        await waitUntilVisible(first, '#cupid-waiting-message');
        // The Cupid sees the first acceptance while the second is still pending.
        await expect(cupid.locator('#lover-status-list')).toContainText('READY');
        await expect(cupid.locator('#lover-status-list')).toContainText('AWAKENING...');
        // One confirmation is not a sealed bond: still nothing in the sleep view.
        expect(await isVisible(cupid, '#night-cupid-sealed')).toBe(false);

        await second.locator('#confirm-love-btn').click();

        // The second confirmation advances the night and the status list is torn down in
        // the same snapshot. The suit is completed by the sleep view's sealed line, which
        // is the only place the Cupid can learn that both lovers accepted.
        await waitUntilVisible(cupid, '#night-sleep-view');
        await waitUntilVisible(cupid, '#night-cupid-sealed');
        await expect(cupid.locator('#night-cupid-sealed')).toHaveText('The bond is sealed. Both lovers accepted.');

        // Negative space: the same line is in the DOM of a non-Cupid phone from the same
        // snapshot and is never shown there.
        await waitUntilVisible(second, '#night-sleep-view');
        expect(await isVisible(second, '#night-cupid-sealed')).toBe(false);
    });

    test('red lady: visits a host, and dies with them at dawn (the implemented rule)', async ({ browser }) => {
        test.slow();

        // The Red Lady only exists from 8 players up. Night order: Cupid, Red Lady...
        const game = await startGameWithPlayers(browser, 8);
        phones = game.phones;
        watch(phones);

        const redIndex = game.roles.indexOf('Red Lady');
        expect(redIndex, `the 8-player preset must deal a Red Lady, got ${game.roles.join(', ')}`).toBeGreaterThanOrEqual(0);
        const wolves = indexesOf(game, 'Werewolf');
        expect(wolves).toHaveLength(2);
        const hostIndex = game.roles.findIndex((role, index) => role === 'Villager' && index !== redIndex);
        expect(hostIndex).toBeGreaterThanOrEqual(0);
        const hostName = nameOf(hostIndex);

        // Skip Cupid; the Red Lady (night order 2) is next.
        const redLady = phones[redIndex]!.page;
        await advanceUntil(game, () => isVisible(redLady, '#red-lady-target-list'), 4);
        await waitUntilVisible(redLady, '#red-lady-target-list');

        await redLady.locator('#red-lady-target-list li.selectable-player').filter({ hasText: hostName }).click();
        await expect(redLady.locator('#confirm-sleepover-btn')).toBeEnabled();
        await redLady.locator('#confirm-sleepover-btn').click();

        // Reality check (role.handler.ts returns true on a successful visit): the night
        // moves straight on to the wolves, so her own sub-view is torn down at once. The
        // waiting message inside it never gets a frame - she learns the outcome at dawn.
        await waitUntilHidden(redLady, '#night-action-container');
        await waitUntilVisible(redLady, '#night-sleep-view');
        await expect(redLady.locator('#red-lady-waiting-message')).toHaveCount(0);
        await waitUntilVisible(phones[wolves[0]!]!.page, '#werewolf-target-list');

        // The wolves kill her host; night.handler.ts then kills the Red Lady too.
        for (const wolf of wolves) await voteAsWolf(game, wolf, hostName);
        const seerIndex = game.roles.indexOf('Seer');
        expect(seerIndex).toBeGreaterThanOrEqual(0);
        await waitUntilVisible(phones[seerIndex]!.page, '#seer-target-list');
        await advance(game); // skip the seer
        // Resolve the night without dismissing the GM's own popup, so the announcement
        // can be checked on every phone.
        await advanceOnce(game.gm); // skip the witch -> dawn
        await waitUntilVisible(game.gm, '#sheriff-voting-view');

        for (const phone of phones) await waitUntilVisible(phone.page, '#death-popup-overlay');
        await expect(redLady.locator('#newly-dead-list')).toContainText(hostName);
        await expect(redLady.locator('#newly-dead-list')).toContainText(nameOf(redIndex));
        await expect(redLady.locator('#newly-dead-list')).toContainText('Red Lady');
        await expect(phones[hostIndex]!.page.locator('#newly-dead-list')).toContainText(hostName);
    });

    test('werewolves: both see each other, the same list and each other\'s votes, and the night waits for both', async ({ browser }) => {
        test.slow();

        const game = await startGameWithPlayers(browser, 6);
        phones = game.phones;
        watch(phones);

        const wolves = indexesOf(game, 'Werewolf');
        expect(wolves).toHaveLength(2);
        const [firstIndex, secondIndex] = wolves as [number, number];
        const first = phones[firstIndex]!.page;
        const second = phones[secondIndex]!.page;

        await waitUntilVisible(first, '#werewolf-target-list');
        await waitUntilVisible(second, '#werewolf-target-list');

        // Both wolves appear on each other's victim list...
        await expect(first.locator('#werewolf-target-list')).toContainText(nameOf(secondIndex));
        await expect(second.locator('#werewolf-target-list')).toContainText(nameOf(firstIndex));

        // ...and the list is the same target list, seat for seat.
        const firstList = await first.locator('#werewolf-target-list').textContent();
        const secondList = await second.locator('#werewolf-target-list').textContent();
        expect(secondList).toBe(firstList);

        const victimIndex = game.roles.indexOf('Villager');
        expect(victimIndex).toBeGreaterThanOrEqual(0);
        const victimName = nameOf(victimIndex);

        await voteAsWolf(game, firstIndex, victimName);
        await expect(first.locator('#werewolf-waiting-message')).toBeVisible();
        // The second wolf sees the first wolf's mark on that target.
        await expect(
            second.locator('#werewolf-target-list li.selectable-player').filter({ hasText: victimName }),
        ).toContainText('🐺');

        // One vote is not a pack decision: the turn has not moved on.
        await expect(second.locator('#werewolf-controls')).toBeVisible();
        const seerIndex = game.roles.indexOf('Seer');
        expect(seerIndex).toBeGreaterThanOrEqual(0);
        expect(await isVisible(phones[seerIndex]!.page, '#seer-target-list')).toBe(false);

        await voteAsWolf(game, secondIndex, victimName);
        await waitUntilVisible(phones[seerIndex]!.page, '#seer-target-list');
        await waitUntilHidden(first, '#night-action-container');
        await waitUntilHidden(second, '#night-action-container');
    });

    test('villager: only the sleep screen, no action container, no role name', async ({ browser }) => {
        test.slow();

        const game = await startGameWithPlayers(browser, 6);
        phones = game.phones;
        watch(phones);

        // A non-manager villager: the manager's turn display names the active role by
        // design, so the sleeping-villager claim is only testable on a normal seat.
        const villagerIndex = game.roles.findIndex((role, index) => index !== 0 && role === 'Villager');
        expect(villagerIndex, `a non-manager villager must exist, got ${game.roles.join(', ')}`).toBeGreaterThan(0);
        const villager = phones[villagerIndex]!.page;

        await waitUntilVisible(villager, '#night-sleep-view');
        expect(await isVisible(villager, '#night-action-container')).toBe(false);
        expect(await isVisible(villager, '#witch-victim-reveal')).toBe(false);
        await expect(villager.locator('#night-current-turn-display')).toHaveText(SLEEP_TEXT);
        await expect(villager.locator('#night-current-turn-display')).not.toContainText('Werewolf');
        await expect(villager.locator('#night-current-turn-display')).not.toContainText('Seer');

        // Still a bystander on the next sub-turn of the same night.
        await advance(game);
        await waitUntilVisible(villager, '#night-sleep-view');
        expect(await isVisible(villager, '#night-action-container')).toBe(false);
        await expect(villager.locator('#night-current-turn-display')).toHaveText(SLEEP_TEXT);
    });

    test('cupid is first-night-only: night two starts with the next role and never shows a cupid screen', async ({ browser }) => {
        test.slow();

        const game = await startGameWithPlayers(browser, 7);
        phones = game.phones;
        watch(phones);

        const cupidIndex = game.roles.indexOf('Cupid');
        expect(cupidIndex).toBeGreaterThanOrEqual(0);
        const cupid = phones[cupidIndex]!.page;

        // Night one really does show the Cupid first.
        await waitUntilVisible(cupid, '#cupid-selection-view');

        // Skip the whole first night, the election and a quiet day into night two.
        await advanceUntilVisibleOn(game, '#day-nomination-view', 12);
        // Empty nominations resolve in one step, the next one starts the night.
        for (let step = 0; step < 2; step++) await advance(game);
        await waitUntilHidden(game.gm, '#day-nomination-view');

        // Night two starts with the wolves, not the Cupid.
        await waitUntilVisible(cupid, '#night-sleep-view');
        await expect(game.gm.locator('#night-current-turn-display')).toContainText('Werewolves');
        expect(await isVisible(cupid, '#cupid-selection-view')).toBe(false);
        expect(await isVisible(cupid, '#cupid-status-view')).toBe(false);
        await expect(cupid.locator('#cupid-target-list')).toHaveCount(0);

        // Walk the whole second night: no cupid screen appears at any sub-turn.
        for (let step = 0; step < 3; step++) {
            expect(await isVisible(cupid, '#cupid-selection-view'), `cupid woke on night 2, step ${step}`).toBe(false);
            expect(await isVisible(cupid, '#cupid-status-view')).toBe(false);
            await advance(game);
        }
    });

    test('a role killed at dawn does not wake: the dead seer gets no action screen on the next night', async ({ browser }) => {
        test.slow();

        const game = await startGameWithPlayers(browser, 6);
        phones = game.phones;
        watch(phones);

        const wolves = indexesOf(game, 'Werewolf');
        expect(wolves).toHaveLength(2);
        const seerIndex = game.roles.indexOf('Seer');
        expect(seerIndex).toBeGreaterThanOrEqual(0);
        const seer = phones[seerIndex]!.page;
        const seerName = nameOf(seerIndex);

        // Night one: the pack kills the seer. She still wakes once, before dawn.
        await voteAsWolf(game, wolves[0]!, seerName);
        await voteAsWolf(game, wolves[1]!, seerName);
        await waitUntilVisible(seer, '#seer-target-list');

        // Skip the seer, then resolve the night without dismissing the GM's own popup,
        // so the announcement can be checked on every phone.
        await advance(game); // seer -> witch
        await advanceOnce(game.gm); // witch -> dawn
        await waitUntilVisible(game.gm, '#sheriff-voting-view');
        for (const phone of phones) await waitUntilVisible(phone.page, '#death-popup-overlay');
        await expect(seer.locator('#newly-dead-list')).toContainText(seerName);
        for (const phone of phones) await dismissDeathPopup(phone.page);

        await advanceIntoNextNight(game);

        // Night two: the dead seer watches from the grave instead of acting.
        await advanceToRole(game, 'Werewolf');
        await waitUntilVisible(seer, '#night-dead-view');
        expect(await isVisible(seer, '#night-action-container')).toBe(false);
        expect(await isVisible(seer, '#seer-target-list')).toBe(false);

        // The seer's slot in the night order passes without a screen.
        await advance(game);
        expect(await isVisible(seer, '#night-dead-view')).toBe(true);
        expect(await isVisible(seer, '#seer-target-list')).toBe(false);
        expect(await isVisible(seer, '#night-action-container')).toBe(false);
        await expect(seer.locator('#seer-target-list')).toHaveCount(0);
    });
});
