import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
    closePhones,
    collectPageErrors,
    createGame,
    failOnDialogs,
    isVisible,
    joinGame,
    newPhone,
    setName,
    startGameWithPlayers,
    waitUntilHidden,
    waitUntilVisible,
} from '../lib/flows';
import type { Phone } from '../lib/flows';

// What a person actually taps, and which screen they land on next. The rules (who
// dies, who wins) belong to the backend suites; this file only proves the phone UI
// exposes those flows and that the manager badge stays private.

// U+2026, copied from night.html. The exact wording is the point: a non-manager must
// learn nothing about which role is awake.
const SLEEP_TEXT = 'Close your eyes…';

// Display names the shared fixture sets: phones[0] is the GM, phones[i] is "Player i".
const nameOf = (index: number): string => (index === 0 ? 'Gamemaster' : `Player ${index}`);

/**
 * One stage of the GM escape hatch: arm, confirm, and wait until the button is re-armed.
 * That last wait is the whole point: the confirm tap disables the button synchronously and
 * only the following snapshot re-enables it. Reading the screen before that wait sees the
 * *previous* state, so a naive "look, then advance" loop would advance one stage too far.
 */
async function advanceOnce(gm: Page): Promise<void> {
    const advanceBtn = gm.locator('#manager-advance-btn');
    await expect(advanceBtn).toBeVisible();
    await expect(advanceBtn).toBeEnabled();
    await advanceBtn.click();

    const confirm = gm.locator('#manager-advance-confirm');
    await expect(confirm).toBeVisible();
    const confirmBtn = gm.locator('#manager-advance-confirm-btn');
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();
    await expect(confirm).toBeHidden();

    // The tap disabled the button synchronously; it is only re-armed by the next
    // snapshot. Waiting here means callers never read a screen from before the step.
    await expect(advanceBtn).toBeEnabled();
}

/** Escape-hatches one stage at a time until `selector` is on screen. */
async function advanceUntilVisible(gm: Page, selector: string, maxSteps = 12): Promise<void> {
    for (let step = 0; step < maxSteps; step++) {
        if (await isVisible(gm, selector)) return;
        await advanceOnce(gm);
    }
    await waitUntilVisible(gm, selector);
}

/**
 * The night action container is visible on exactly one phone: the role whose turn it
 * is. Returns that phone's index, so specs never assume a seat order.
 */
async function onlyActingIndex(phones: Phone[]): Promise<number> {
    let index = -1;
    await expect
        .poll(
            async () => {
                const flags = await Promise.all(phones.map((phone) => isVisible(phone.page, '#night-action-container')));
                const visible = flags.flatMap((on, i) => (on ? [i] : []));
                index = visible.length === 1 ? visible[0]! : -1;
                return visible.length;
            },
            { timeout: 15_000, message: 'exactly one phone must show a night action' },
        )
        .toBe(1);
    return index;
}

/**
 * Every phone that currently gets a night action. A pack wakes as one role on several
 * phones, so night 2 of a two-wolf preset legitimately answers more than one index.
 */
async function actingIndexes(phones: Phone[]): Promise<number[]> {
    let indexes: number[] = [];
    await expect
        .poll(
            async () => {
                const flags = await Promise.all(phones.map((phone) => isVisible(phone.page, '#night-action-container')));
                indexes = flags.flatMap((on, i) => (on ? [i] : []));
                return indexes.length;
            },
            { timeout: 15_000, message: 'the next night must give at least one phone an action' },
        )
        .toBeGreaterThan(0);
    return indexes;
}

test.describe('gameplay', () => {
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

    test('lobby: names reach every phone and only the GM holds the start button', async ({ browser }) => {
        test.slow();

        for (let i = 0; i < 4; i++) phones.push(await newPhone(browser));
        watch(phones);
        const gm = phones[0]!.page;

        const code = await createGame(gm);
        await setName(gm, nameOf(0));
        for (let i = 1; i < phones.length; i++) {
            await joinGame(phones[i]!.page, code);
            await setName(phones[i]!.page, nameOf(i));
        }

        // The count is the whole village; the list deliberately hides your own seat.
        for (const phone of phones) {
            await expect(phone.page.locator('#player-count')).toHaveText('4');
        }
        for (const playerName of ['Player 1', 'Player 2', 'Player 3']) {
            await expect(gm.locator('#lobby-players-list')).toContainText(playerName);
        }
        await expect(gm.locator('#lobby-players-list')).not.toContainText('Gamemaster');
        for (let i = 1; i < phones.length; i++) {
            const list = phones[i]!.page.locator('#lobby-players-list');
            await expect(list).toContainText('Gamemaster');
            await expect(list).not.toContainText(nameOf(i));
        }

        // Manager-only controls. Wait for the GM's copy so the state has certainly arrived
        // before asserting that the other phones do not have it.
        await waitUntilVisible(gm, '#manager-controls');
        for (const phone of phones.slice(1)) {
            expect(await isVisible(phone.page, '#manager-controls')).toBe(false);
            await expect(phone.page.locator('#player-waiting-message')).toBeVisible();
        }

        // A rename shows up as somebody else's name, never as a second self.
        const renamed = phones[2]!.page;
        await setName(renamed, 'Renamed Rolf');
        for (const page of [gm, phones[1]!.page, phones[3]!.page]) {
            await expect(page.locator('#lobby-players-list')).toContainText('Renamed Rolf');
        }
        await expect(gm.locator('#lobby-players-list')).not.toContainText('Player 2');
        await expect(renamed.locator('#lobby-players-list')).not.toContainText('Renamed Rolf');
    });

    test('night: the acting role picks a target, confirms, and hands the night on', async ({ browser }) => {
        test.slow();

        const game = await startGameWithPlayers(browser, 4);
        phones = game.phones;
        watch(phones);

        const acting = await onlyActingIndex(phones);
        const role = game.roles[acting]!;
        // The 4-player preset deals one Werewolf and one Seer; the wolf wakes first.
        expect(role, `the 4-player preset must open the night with the Werewolf, got ${role}`).toBe('Werewolf');
        const actor = phones[acting]!.page;

        // Nobody else gets an action UI.
        for (const [index, phone] of phones.entries()) {
            if (index === acting) continue;
            await waitUntilVisible(phone.page, '#night-sleep-view');
            expect(await isVisible(phone.page, '#night-action-container')).toBe(false);
        }

        const targets = actor.locator('#werewolf-target-list li.selectable-player');
        await expect(targets.first()).toBeVisible();
        // The backend rejects a wolf voting for itself, so never tap our own seat.
        const target = targets.filter({ hasNotText: nameOf(acting) }).first();
        await target.click();
        await expect(actor.locator('#werewolf-target-list li.selected')).toHaveCount(1);

        const confirm = actor.locator('#confirm-werewolf-target-btn');
        await expect(confirm).toBeEnabled();
        await confirm.click();

        // The wolf is done for the night...
        await waitUntilHidden(actor, '#night-action-container');
        await waitUntilVisible(actor, '#night-sleep-view');

        // ...and the next role (the Seer in this preset) has its own turn.
        const seerIndex = game.roles.indexOf('Seer');
        if (seerIndex < 0) throw new Error(`the 4-player preset must deal a Seer, got ${game.roles.join(', ')}`);
        await waitUntilVisible(phones[seerIndex]!.page, '#seer-target-list');
    });

    test('night: a bystander only sees the sleep view, never the active role name', async ({ browser }) => {
        test.slow();

        const game = await startGameWithPlayers(browser, 4);
        phones = game.phones;
        watch(phones);

        const acting = await onlyActingIndex(phones);
        expect(game.roles[acting]).toBe('Werewolf');

        // Two Villagers are dealt, at most one of them is the GM, so a plain bystander exists.
        const bystanderIndex = game.roles.findIndex((role, index) => index !== 0 && role === 'Villager');
        if (bystanderIndex < 0) {
            throw new Error(`no non-manager Villager to observe, roles were ${game.roles.join(', ')}`);
        }
        const bystander = phones[bystanderIndex]!.page;

        await waitUntilVisible(bystander, '#night-sleep-view');
        expect(await isVisible(bystander, '#night-action-container')).toBe(false);

        const turnDisplay = bystander.locator('#night-current-turn-display');
        await expect(turnDisplay).toBeVisible();
        await expect(turnDisplay).toHaveText(SLEEP_TEXT);
        await expect(turnDisplay).not.toContainText('Werewolf');

        // Contrast: the GM runs the night, so it does get told whose turn it is.
        if (game.roles[0] !== 'Werewolf') {
            const gmTurnDisplay = phones[0]!.page.locator('#night-current-turn-display');
            await expect(gmTurnDisplay).toBeVisible();
            await expect(gmTurnDisplay).toContainText('Werewolves');
        }
    });

    test('day: nomination locks, the trial vote resolves, and the round trip reaches the next night', async ({ browser }) => {
        test.slow();

        // 7 players, not 6: the role presets put a Cupid in only from 7 up (6 is two wolves,
        // two villagers, seer, witch). The Cupid is what proves a first-night-only role sleeps
        // through night 2, so it has to actually be in this game.
        const game = await startGameWithPlayers(browser, 7);
        phones = game.phones;
        watch(phones);
        const gm = game.gm;

        // Fastest legitimate route: skip the unplayed night and the sheriff election.
        await advanceUntilVisible(gm, '#day-nomination-view');
        for (const phone of phones) {
            await expect(phone.page.locator('#day-nomination-view')).toBeVisible();
        }
        await expect(gm.locator('#day-available-list')).toContainText('Nominate No One');

        // Nominate a non-wolf, so the lynch cannot end the game before the result screen.
        const voterIndex = 1;
        const voter = phones[voterIndex]!.page;
        const targetIndex = game.roles.findIndex((role, index) => index !== voterIndex && (role === 'Villager' || role === 'Seer'));
        if (targetIndex < 0) throw new Error(`no lynchable non-wolf in roles ${game.roles.join(', ')}`);
        const targetName = nameOf(targetIndex);

        const candidate = voter.locator('#day-available-list li.nomination-item').filter({ hasText: targetName });
        await expect(candidate).toHaveCount(1);
        await candidate.click();
        await expect(candidate).toHaveClass(/selected/);

        const nominateBtn = voter.locator('#confirm-nomination-btn');
        await expect(nominateBtn).toBeEnabled();
        await nominateBtn.click();

        // Per-view lock: the nomination is confirmed for me and cannot be repeated.
        const nominationConfirmation = voter.locator('#nomination-confirmed-message');
        await expect(nominationConfirmation).toBeVisible();
        await expect(nominationConfirmation).toContainText(`You have nominated ${targetName}`);
        await expect(voter.locator('#day-nomination-controls')).toBeHidden();

        // The trial list is shared: someone else's phone shows the nomination too.
        const other = phones[(voterIndex + 1) % phones.length]!.page;
        await expect(other.locator('#day-nominated-list')).toContainText(targetName);
        await expect(other.locator('#day-nominated-list')).toContainText(`Nominated by ${nameOf(voterIndex)}`);

        // The escape hatch fills the missing nominations with abstains and opens the trial.
        await advanceOnce(gm);
        for (const phone of phones) {
            await expect(phone.page.locator('#day-voting-view')).toBeVisible();
        }
        await expect(voter.locator('#day-vote-list')).toContainText(targetName);

        const votingItem = voter.locator('#day-vote-list li.voting-item').filter({ hasText: targetName });
        await expect(votingItem).toHaveCount(1);
        await votingItem.click();
        const voteBtn = voter.locator('#confirm-vote-btn');
        await expect(voteBtn).toBeEnabled();
        await voteBtn.click();
        await expect(voter.locator('#vote-confirmed-message')).toBeVisible();
        await expect(voter.locator('#day-voting-controls')).toBeHidden();

        // One more escape-hatch step fills the missing votes: our single vote wins.
        await advanceOnce(gm);
        for (const phone of phones) {
            await expect(phone.page.locator('#day-result-view')).toBeVisible();
        }
        await expect(voter.locator('#lynched-player-name')).toHaveText(targetName);
        await expect(voter.locator('#day-vote-breakdown')).toContainText('1 Votes');

        // The death announcement is the confirmation every phone has to show (and has to
        // dismiss: it is a full-screen overlay that would swallow the next tap).
        await expect(voter.locator('#death-popup-overlay')).toBeVisible();
        await expect(voter.locator('#newly-dead-list')).toContainText(targetName);
        for (const phone of phones) {
            const popup = phone.page.locator('#death-popup-overlay');
            await expect(popup).toBeVisible();
            await phone.page.locator('#close-death-popup').click();
            await expect(popup).toBeHidden();
        }

        // ROUND TRIP: the result screen has to lead back into a night. Every *living* phone
        // confirms; the lynched phone has no such button, and the night must not start before
        // the last living player has tapped.
        const livingIndexes = phones.map((_, index) => index).filter((index) => index !== targetIndex);
        const deadPhone = phones[targetIndex]!.page;
        await expect(deadPhone.locator('#ready-for-night-btn')).toBeHidden();

        for (const index of livingIndexes.slice(0, -1)) {
            const page = phones[index]!.page;
            await page.locator('#ready-for-night-btn').click();
            await expect(page.locator('#night-waiting-message')).toBeVisible();
        }
        // Everyone but the last living phone has confirmed: still the day.
        await expect(phones[livingIndexes[0]!]!.page.locator('#day-result-view')).toBeVisible();

        await phones[livingIndexes[livingIndexes.length - 1]!]!.page.locator('#ready-for-night-btn').click();

        // The day view is gone and everyone is back in the night, on their own screen.
        for (const phone of phones) {
            await expect(phone.page.locator('#day-result-view')).toBeHidden();
        }
        for (const index of livingIndexes) {
            const page = phones[index]!.page;
            await expect
                .poll(
                    async () => (await isVisible(page, '#night-action-container')) || (await isVisible(page, '#night-sleep-view')),
                    { timeout: 15_000, message: `living phone ${index} never reached the next night` },
                )
                .toBe(true);
        }

        // 1. The lynched player gets no night turn at all.
        await waitUntilVisible(deadPhone, '#night-dead-view');
        expect(await isVisible(deadPhone, '#night-action-container')).toBe(false);

        // 2. The Cupid is first-night-only: on night 2 it is asleep like any bystander.
        const cupidIndex = game.roles.indexOf('Cupid');
        if (cupidIndex < 0) throw new Error(`the 7-player preset must deal a Cupid, got ${game.roles.join(', ')}`);
        expect(livingIndexes).toContain(cupidIndex);
        await waitUntilVisible(phones[cupidIndex]!.page, '#night-sleep-view');
        expect(await isVisible(phones[cupidIndex]!.page, '#night-action-container')).toBe(false);

        // Whoever does wake is a waking role, is still alive, and is not the Cupid again.
        const actors = await actingIndexes(phones);
        for (const index of actors) {
            expect(['Cupid', 'Red Lady', 'Werewolf', 'Seer', 'Witch'], `phone ${index} woke as ${game.roles[index]}`)
                .toContain(game.roles[index]);
            expect(livingIndexes, `phone ${index} is lynched but acting`).toContain(index);
            expect(game.roles[index], 'Cupid must not wake on night 2').not.toBe('Cupid');
        }

        // The manager is the only seat that may be told the role name (B41); it must name the
        // new turn and must never say "Cupids" again.
        const managerTurnDisplay = phones[0]!.page.locator('#night-current-turn-display');
        await expect(managerTurnDisplay).toContainText('Current Turn:');
        await expect(managerTurnDisplay).not.toContainText('Cupids');
    });

    test('GM escape hatch: players never see it, and it is a deliberate two-step', async ({ browser }) => {
        test.slow();

        const game = await startGameWithPlayers(browser, 4);
        phones = game.phones;
        watch(phones);
        const gm = game.gm;

        const acting = await onlyActingIndex(phones);

        await waitUntilVisible(gm, '#manager-advance-view');
        for (let i = 1; i < phones.length; i++) {
            expect(
                await isVisible(phones[i]!.page, '#manager-advance-view'),
                `player ${i} must not see the manager escape hatch`,
            ).toBe(false);
        }

        // One tap only arms it; Cancel puts the button back and changes nothing.
        const advanceBtn = gm.locator('#manager-advance-btn');
        const confirm = gm.locator('#manager-advance-confirm');
        await advanceBtn.click();
        await expect(confirm).toBeVisible();
        await expect(advanceBtn).toBeHidden();
        await gm.locator('#manager-advance-cancel-btn').click();
        await expect(confirm).toBeHidden();
        await expect(advanceBtn).toBeVisible();
        expect(await isVisible(phones[acting]!.page, '#night-action-container')).toBe(true);

        // Confirming really advances exactly one stage: the wolf hands over to the Seer.
        await advanceOnce(gm);
        await waitUntilVisible(phones[acting]!.page, '#night-sleep-view');
        const seerIndex = game.roles.indexOf('Seer');
        if (seerIndex < 0) throw new Error(`the 4-player preset must deal a Seer, got ${game.roles.join(', ')}`);
        await waitUntilVisible(phones[seerIndex]!.page, '#seer-target-list');
    });
});
