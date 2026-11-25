import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
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
    waitForPointerReady,
    waitUntilVisible,
} from '../lib/flows';
import type { Phone } from '../lib/flows';

// Robustness: no flow may leave a phone on a dead or half-rendered screen, and the
// manager's escape hatch must stay invisible to everybody else.

/** Records socket.io events so "created twice" is observable, not inferred from timing. */
async function recordSocketEvents(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const target = window as any;
        target.__socketEvents = [];
        const Native = window.WebSocket;
        class RecordingWebSocket extends Native {
            constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols);
                this.addEventListener('message', (event) => {
                    if (typeof event.data !== 'string') return;
                    for (const packet of event.data.split('\x1e')) {
                        if (!packet.startsWith('42')) continue;
                        try {
                            const [name] = JSON.parse(packet.slice(2));
                            target.__socketEvents.push(name);
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

const socketEvents = (page: Page): Promise<string[]> =>
    page.evaluate(() => (window as any).__socketEvents ?? []);

test.describe('robustness', () => {
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

    /** A manager alone in a fresh lobby; the route change has just armed the guard. */
    async function createManagerLobby(browser: Browser): Promise<{ gm: Page; code: string }> {
        const phone = await newPhone(browser);
        phones.push(phone);
        collectPageErrors(phone.page, pageErrors);
        failOnDialogs(phone.page, dialogs);

        const gm = phone.page;
        await gm.goto('/');
        await waitForPointerReady(gm);
        await gm.locator('#create-game').click();

        // No polled assertion before returning: the tests fire their stray tap right after
        // this mount event, and a poll would eat into the 400ms guard window.
        await gm.locator('#lobby-players-list').waitFor({ state: 'attached' });

        const code = /#\/game\/([A-Z0-9]{4})/.exec(gm.url())?.[1];
        if (!code) throw new Error(`no game code in ${gm.url()}`);
        return { gm, code };
    }

    async function addPlayers(browser: Browser, code: string, count: number): Promise<void> {
        for (let i = 1; i <= count; i++) {
            const phone = await newPhone(browser);
            phones.push(phone);
            collectPageErrors(phone.page, pageErrors);
            failOnDialogs(phone.page, dialogs);
            await joinGame(phone.page, code);
            await setName(phone.page, `Player ${i}`);
        }
    }

    test('a failed join shows the error card instead of a black screen', async ({ browser }) => {
        const phone = await newPhone(browser);
        phones = [phone];
        collectPageErrors(phone.page, pageErrors, /Game with ID ZZZZ not found/);
        failOnDialogs(phone.page, dialogs);

        await phone.page.goto('/#/game/ZZZZ');

        await expect(phone.page.locator('#game-error-view')).toBeVisible();
        await expect(phone.page.locator('#game-error-message')).not.toBeEmpty();

        // The phase container must not be left behind half-rendered under the error card.
        await expect(phone.page.locator('#phase-view-container')).toBeHidden();
        const phaseMarkup = await phone.page.locator('#phase-view-container').evaluate((el) => el.innerHTML.trim());
        expect(phaseMarkup).toBe('');

        // The error card was reached by a route change, so input is ignored for a moment.
        await waitForPointerReady(phone.page);
        await phone.page.locator('#game-error-back-btn').click();
        await expect(phone.page.locator('#create-game')).toBeVisible();
        // Back is a route change, so the start page ignores input for a moment.
        await waitForPointerReady(phone.page);

        const code = await createGame(phone.page);
        await expect(phone.page.locator('#lobby-game-id')).toHaveText(code);
        await expect(phone.page.locator('#game-error-view')).toBeHidden();
    });

    test('browser Back during the server gate leaves no overlay', async ({ browser }) => {
        // The gate overlay only exists while the socket is not connected yet. On a warm
        // local backend that window is ~300ms, so hold the websocket open without an
        // upstream server: this is exactly the cold start B35 describes, minus the race.
        const gated = await newPhone(browser);
        phones.push(gated);
        collectPageErrors(gated.page, pageErrors);
        failOnDialogs(gated.page, dialogs);

        await gated.page.routeWebSocket(/socket\.io/, () => {
            // never connect upstream, so the gate stays up
        });
        await gated.page.goto('/');
        await expect(gated.page.locator('#create-game')).toBeVisible();

        // Second history entry, so Back lands on the start page of this app.
        await gated.page.goto('/#/game/ABCD');
        await waitUntilVisible(gated.page, '#server-gate-overlay');

        await gated.page.goBack();

        await waitUntilVisible(gated.page, '#create-game');
        await expect(gated.page.locator('#server-gate-overlay')).toHaveCount(0);
        expect(await isVisible(gated.page, '#server-gate-overlay')).toBe(false);

        // Leaving a real game page with Back must also not leave the fixed overlay behind.
        const player = await newPhone(browser);
        phones.push(player);
        collectPageErrors(player.page, pageErrors);
        failOnDialogs(player.page, dialogs);

        await player.page.goto('/');
        await player.page.locator('#create-game').click();
        await expect(player.page).toHaveURL(/#\/game\/[A-Z0-9]{4}/, { timeout: 30_000 });
        await waitUntilVisible(player.page, '#lobby-game-id');
        await expect(player.page.locator('#lobby-players-list')).toHaveCount(1);

        await player.page.goBack();

        await waitUntilVisible(player.page, '#create-game');
        await expect(player.page.locator('#server-gate-overlay')).toHaveCount(0);
    });

    test('double-tapping Create Game creates exactly one game', async ({ browser }) => {
        const phone = await newPhone(browser);
        phones = [phone];
        await recordSocketEvents(phone.page);
        collectPageErrors(phone.page, pageErrors);
        failOnDialogs(phone.page, dialogs);

        await phone.page.goto('/');
        const create = phone.page.locator('#create-game');
        await expect(create).toBeVisible();

        // Two taps in the same frame: the case the in-flight guard exists for. A synthetic
        // double-click is not used because its second tap can land after the app has
        // already navigated, which measures the lobby's layout instead of this guard.
        await phone.page.evaluate(() => {
            const button = document.getElementById('create-game') as HTMLButtonElement;
            button.click();
            button.click();
        });

        await expect(phone.page).toHaveURL(/#\/game\/[A-Z0-9]{4}/, { timeout: 30_000 });
        const code = /#\/game\/([A-Z0-9]{4})/.exec(phone.page.url())?.[1];
        expect(code, `no game code in ${phone.page.url()}`).toBeTruthy();

        await expect(phone.page.locator('#lobby-game-id')).toHaveText(code!);
        // The creator is alone in the lobby, so the (empty) player list has no height.
        await expect(phone.page.locator('#player-count')).toHaveText('1');

        // Survive a real round trip without being whisked to a second game.
        await setName(phone.page, 'Only Game');
        await expect(phone.page).toHaveURL(new RegExp(`#/game/${code}$`));
        await expect(phone.page.locator('#lobby-game-id')).toHaveText(code!);
        expect((await socketEvents(phone.page)).filter((event) => event === 'gameCreated')).toHaveLength(1);

        // The guard must swallow the second tap, not send it to the server as an error.
        expect(dialogs, 'a second tap must not surface as a server error').toEqual([]);
    });

    test('a stray second tap after navigation cannot act on the new screen', async ({ browser }) => {
        test.slow();

        const { gm, code } = await createManagerLobby(browser);

        // The stray tap: a raw click on the lobby's own button, inside the window the
        // route change into the lobby just armed. dispatchEvent skips actionability
        // checks, which is what a physical tap on the new screen does.
        await gm.locator('#start-game-btn').dispatchEvent('click');

        // Nothing reached the lobby: the manager UI is intact, the click handler never ran
        // (the button would have disabled itself while in flight), no phase moved, no alert.
        await expect(gm.locator('#manager-controls')).toBeVisible();
        await expect(gm.locator('#confirm-roles-btn')).toHaveCount(0);
        await expect(gm.locator('#start-game-btn')).toBeEnabled();
        await expect(gm.locator('#lobby-game-id')).toHaveText(code);
        await expect(gm.locator('#player-count')).toHaveText('1');
        expect(dialogs, 'the stray tap must not reach closeJoining and alert').toEqual([]);

        // Normal use must still work: fill the lobby, let the guard release, tap again.
        await addPlayers(browser, code, 3);
        await expect(gm.locator('#player-count')).toHaveText('4');

        await waitForPointerReady(gm);
        await expect(gm.locator('#start-game-btn')).toBeEnabled();
        await gm.locator('#start-game-btn').click();
        await waitUntilVisible(gm, '#confirm-roles-btn');
    });

    test('the manager advance control is invisible to players', async ({ browser }) => {
        test.slow();

        const game = await startGameWithPlayers(browser, 4);
        phones = game.phones;
        phones.forEach(({ page }) => {
            collectPageErrors(page, pageErrors);
            failOnDialogs(page, dialogs);
        });

        const visible = await Promise.all(phones.map(({ page }) => isVisible(page, '#manager-advance-view')));
        expect(visible.filter(Boolean), 'exactly one seat holds the manager badge').toHaveLength(1);
        expect(visible[0]).toBe(true);

        for (const page of game.players) {
            expect(await isVisible(page, '#manager-advance-view')).toBe(false);
            expect(await isVisible(page, '#manager-advance-btn')).toBe(false);
            expect(await isVisible(page, '#manager-advance-confirm-btn')).toBe(false);
        }
    });
});
