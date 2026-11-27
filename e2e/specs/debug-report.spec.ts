import { test, expect } from '@playwright/test';
import {
    closePhones,
    collectPageErrors,
    failOnDialogs,
    isVisible,
    startGameWithPlayers,
    waitUntilVisible,
} from '../lib/flows';
import type { Phone } from '../lib/flows';

// The client half of the black box: the GM can hand over one JSON block describing
// everything this phone received. It has to work while the game is running (not after a
// reload), contain the real game, and stay out of everyone else's way.

test.describe('debug report', () => {
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

    test('the GM can copy a complete client report, and nobody else sees the button', async ({ browser }) => {
        test.slow();

        const game = await startGameWithPlayers(browser, 4);
        phones = game.phones;
        for (const phone of phones) {
            collectPageErrors(phone.page, pageErrors);
            failOnDialogs(phone.page, dialogs);
        }

        await game.phones[0]!.context.grantPermissions(['clipboard-read', 'clipboard-write']);

        // Visible from the first snapshot, not only in a "stuck" phase: the report is for
        // the moment something looks wrong, which is usually before anyone knows why.
        await waitUntilVisible(game.gm, '#debug-report-view');
        await game.gm.locator('#debug-report-view summary').click();
        await expect(game.gm.locator('#copy-debug-report-btn')).toBeVisible();

        // A normal player gets no control, and no private role data to hand over.
        expect(await isVisible(game.players[0]!, '#debug-report-view')).toBe(false);

        await game.gm.locator('#copy-debug-report-btn').click();
        await expect(game.gm.locator('#game-toast')).toContainText('Debug report copied');

        const clipboard = await game.gm.evaluate(() => navigator.clipboard.readText());
        const report = JSON.parse(clipboard) as {
            kind: string;
            gameId: string;
            playerUUID: string;
            phase: string;
            isManager: boolean;
            warning: string;
            state: { role: string; players: unknown[] };
            events: { kind: string; data: unknown }[];
        };

        expect(report.kind).toBe('werwolf-client-debug');
        expect(report.gameId).toBe(game.code);
        expect(report.playerUUID).not.toBeNull();
        expect(report.phase).toBe('NIGHT');
        expect(report.isManager).toBe(true);
        expect(report.warning).toContain('private');
        expect(report.state.role).toBeTruthy();
        expect(report.state.players).toHaveLength(4);

        // The report is a history, not a screenshot: it must contain the snapshots that
        // built the current screen, plus the socket lifecycle around them.
        expect(report.events.some((event) => event.kind === 'socket.syncState')).toBe(true);
        expect(report.events.some((event) => event.kind === 'socket.connect')).toBe(true);
        expect(report.events.some((event) => event.kind === 'game.page_mounted')).toBe(true);
    });
});
