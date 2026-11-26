import { expect, devices } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

// Shared flows for the browser suite. Every helper here corresponds to something a
// person actually does on their phone, so a spec reads like a playtest script.

const PHONE = devices['iPhone 13'];

export interface Phone {
    context: BrowserContext;
    page: Page;
}

/** One browser context = one phone: separate localStorage, socket and cookies. */
export async function newPhone(browser: Browser): Promise<Phone> {
    const context = await browser.newContext({ ...PHONE });
    const page = await context.newPage();
    return { context, page };
}

export async function createGame(page: Page): Promise<string> {
    await page.goto('/');
    await page.locator('#create-game').click();

    // Creating a game may pass through the server gate first (cold backend), so wait
    // for the route rather than for a fixed delay.
    await expect(page).toHaveURL(/#\/game\/[A-Z0-9]{4}/, { timeout: 30_000 });
    const code = /#\/game\/([A-Z0-9]{4})/.exec(page.url())?.[1];
    if (!code) throw new Error(`No game code in URL: ${page.url()}`);

    await expect(page.locator('#lobby-game-id')).toHaveText(code);
    return code;
}

export async function joinGame(page: Page, code: string): Promise<void> {
    await page.goto(`/#/game/${code}`);
    await waitUntilVisible(page, '#lobby-players-list');
}

export async function setName(page: Page, name: string): Promise<void> {
    const input = page.locator('#my-name-input');
    await input.fill(name);
    await input.blur(); // the change handler fires on blur, not on every keystroke
    // The view echoes the server's copy back into the input on the next snapshot.
    await expect(input).toHaveValue(name);
}

export async function closeJoining(gm: Page): Promise<void> {
    await gm.locator('#start-game-btn').click();
    await gm.locator('#confirm-roles-btn').click();
}

/** Deals the preset composition; the role cards are only readable until the game starts. */
export async function readRoleCards(phones: Phone[]): Promise<string[]> {
    const roles: string[] = [];
    for (const phone of phones) {
        const card = phone.page.locator('#role-name-display');
        await expect(card).not.toBeEmpty();
        roles.push((await card.textContent())?.trim() ?? '');
    }
    return roles;
}

export async function startActualGame(gm: Page): Promise<void> {
    await gm.locator('#start-actual-game-btn').click();
}

/** Lobby -> role selection -> distribution -> night, WITHOUT reading the role cards. */
export async function closeJoiningAndStart(gm: Page): Promise<void> {
    await closeJoining(gm);
    await startActualGame(gm);
}

/**
 * Reads computed display state instead of offsetParent, because the phase views are
 * all present in the DOM and only toggled with display:none/block.
 */
export async function isVisible(page: Page, selector: string): Promise<boolean> {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetHeight > 0;
    }, selector);
}

export async function waitUntilVisible(page: Page, selector: string, timeout = 15_000): Promise<void> {
    await expect.poll(() => isVisible(page, selector), { timeout, message: `${selector} never became visible` }).toBe(true);
}

export async function waitUntilHidden(page: Page, selector: string, timeout = 15_000): Promise<void> {
    await expect.poll(async () => !(await isVisible(page, selector)), { timeout, message: `${selector} never became hidden` }).toBe(true);
}

/** Every player has reached the night phase, whichever of the two night panels they get. */
export async function waitForNight(page: Page): Promise<void> {
    await expect
        .poll(
            async () => (await isVisible(page, '#night-action-container')) || (await isVisible(page, '#night-sleep-view')),
            { timeout: 15_000, message: 'player never reached the night phase' },
        )
        .toBe(true);
}

/**
 * One ballot in the sheriff election. It is a direct vote: every living player is a
 * candidate from the first snapshot and the last row is "Abstain from Vote", so there is
 * no nomination stage to drive first. `targetName` null means an explicit abstain.
 */
export async function voteForSheriff(page: Page, targetName: string | null): Promise<void> {
    const ballot = page.locator('#sheriff-vote-list li.selectable-player');
    const candidate = targetName
        ? ballot.filter({ hasText: targetName })
        : ballot.filter({ hasText: 'Abstain from Vote' });
    await expect(candidate, `no sheriff ballot entry for ${targetName ?? 'Abstain from Vote'}`).toHaveCount(1);
    await candidate.click();
    await expect(candidate).toHaveClass(/selected/);

    const confirm = page.locator('#confirm-sheriff-vote-btn');
    await expect(confirm).toBeEnabled();
    await confirm.click();
}

export interface StartedGame {
    code: string;
    gm: Page;
    players: Page[];
    phones: Phone[];
    /** Display name of the role dealt to phones[i] (e.g. "Witch"). Order matches `phones`. */
    roles: string[];
}

/**
 * Creates a game with `playerCount` players total (the GM counts as one), sets a
 * recognisable name per phone and walks lobby -> role selection -> distribution ->
 * night. Returns whatever it opened so the caller can close the contexts.
 */
export async function startGameWithPlayers(browser: Browser, playerCount = 4): Promise<StartedGame> {
    if (playerCount < 4) throw new Error('MIN_PLAYERS is 4');

    const phones: Phone[] = [];
    for (let i = 0; i < playerCount; i++) phones.push(await newPhone(browser));

    const gm = phones[0]!.page;
    const code = await createGame(gm);
    await setName(gm, 'Gamemaster');

    for (let i = 1; i < phones.length; i++) {
        const page = phones[i]!.page;
        await joinGame(page, code);
        await setName(page, `Player ${i}`);
    }

    // Everyone has to be in the lobby before the GM closes it, otherwise role
    // distribution is one role short of the player count. The list only shows the
    // other players, so the count element is the honest check.
    for (const phone of phones) {
        await expect(phone.page.locator('#player-count')).toHaveText(String(playerCount));
    }
    for (const page of phones.slice(1).map((p) => p.page)) {
        await expect(page.locator('#lobby-players-list')).toContainText('Gamemaster');
    }

    await closeJoining(gm);

    // Roles are dealt randomly, so read them off the distribution screen before the
    // game starts. Specs must never assume a particular seat got a particular role.
    const roles = await readRoleCards(phones);

    await startActualGame(gm);

    for (const phone of phones) await waitForNight(phone.page);

    return { code, gm, players: phones.slice(1).map((p) => p.page), phones, roles };
}

/**
 * The router ignores clicks for a moment after a route change (tap-through guard, see
 * frontend/src/router.ts). It mirrors that state on <html data-tap-guard>, so specs can
 * wait for input to be live instead of sleeping.
 */
export async function waitForPointerReady(page: Page, timeout = 5_000): Promise<void> {
    await expect
        .poll(
            () => page.evaluate(() => document.documentElement.dataset.tapGuard ?? 'ready'),
            { timeout, message: 'the tap-through guard never released input' },
        )
        .not.toBe('armed');
}

export async function closePhones(phones: Phone[]): Promise<void> {
    await Promise.all(phones.map((phone) => phone.context.close().catch(() => undefined)));
}

/** Fails a test if the page opened a browser dialog (alert/confirm/prompt). */
export function failOnDialogs(page: Page, sink: string[]): void {
    page.on('dialog', async (dialog) => {
        sink.push(`${dialog.type()}: ${dialog.message()}`);
        await dialog.dismiss();
    });
}

/**
 * Collects page errors for a later assertion. `allowConsoleError` exists because a few
 * flows make the app log on purpose (e.g. a socket error for a bad game id).
 */
export function collectPageErrors(page: Page, sink: string[], allowConsoleError?: RegExp): void {
    page.on('pageerror', (error) => sink.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = `console.error: ${message.text()}`;
        if (allowConsoleError?.test(text)) return;
        sink.push(text);
    });
}
