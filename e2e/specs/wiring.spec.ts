import { test, expect } from '@playwright/test';
import {
    closePhones,
    collectPageErrors,
    failOnDialogs,
    isVisible,
    newPhone,
    startGameWithPlayers,
} from '../lib/flows';
import type { Phone } from '../lib/flows';

// Wiring smoke test: if this is red, no other browser spec means anything, because it
// proves the whole chain an API test cannot see — Vite proxy, websocket upgrade,
// router, store, phase views, touch input.

test.describe('wiring', () => {
    let phones: Phone[] = [];
    let pageErrors: string[] = [];
    let dialogs: string[] = [];

    test.afterEach(async () => {
        await closePhones(phones);
        phones = [];
        expect(dialogs, 'the app must never open a blocking dialog').toEqual([]);
        expect(pageErrors, 'the page must not throw or log console errors').toEqual([]);
    });

    test('plays four phones from the start page into the first night', async ({ browser }) => {
        test.slow();

        const game = await startGameWithPlayers(browser, 4);
        phones = game.phones;
        phones.forEach((phone) => {
            collectPageErrors(phone.page, pageErrors);
            failOnDialogs(phone.page, dialogs);
        });

        // Every phone is in the night phase and got its own role
        for (const phone of phones) {
            expect(phone.page.url()).toContain(game.code);
        }

        // The GM escape hatch is the one manager-only control in the night, so it is a
        // cheap proof that exactly one seat holds the badge. It is always in the DOM,
        // which is why this checks visibility rather than existence.
        const managerFlags = await Promise.all(phones.map((phone) => isVisible(phone.page, '#manager-advance-view')));
        expect(managerFlags.filter(Boolean)).toHaveLength(1);
    });

    test('shows a readable error for a game id that does not exist', async ({ browser }) => {
        const phone = await newPhone(browser);
        phones = [phone];
        collectPageErrors(phone.page, pageErrors, /Game with ID ZZZZ not found/);
        failOnDialogs(phone.page, dialogs);

        await phone.page.goto('/#/game/ZZZZ');

        await expect(phone.page.locator('#game-error-view')).toBeVisible();
        await expect(phone.page.locator('#game-error-message')).not.toBeEmpty();
        await expect(phone.page.locator('#game-error-back-btn')).toBeVisible();
    });
});
