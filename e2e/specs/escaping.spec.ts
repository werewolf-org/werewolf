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
    setName,
    startActualGame,
    waitForNight,
    waitUntilVisible,
} from '../lib/flows';
import type { Phone } from '../lib/flows';

// Stored XSS (B3): a player name is untrusted text. It must render as text in every view
// that interpolates it — lobby, day lists and the death announcement.

const IMG_PAYLOAD = '<img src=x onerror=alert(1)>';
const BOLD_PAYLOAD = '<b>bold</b>';

const injectedElementCount = (page: Page): Promise<number> =>
    page.evaluate(() => document.querySelectorAll('img[src="x"], b').length);

/** Records syncState so the GM escape hatch can wait for the server to move one step. */
async function recordSnapshots(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const target = window as any;
        target.__syncSnapshots = [];
        const Native = window.WebSocket;
        class RecordingWebSocket extends Native {
            constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols);
                this.addEventListener('message', (event) => {
                    if (typeof event.data !== 'string') return;
                    for (const packet of event.data.split('\x1e')) {
                        if (!packet.startsWith('42')) continue;
                        try {
                            const [name, data] = JSON.parse(packet.slice(2));
                            if (name === 'syncState') target.__syncSnapshots.push(data);
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

const latestSnapshot = (page: Page): Promise<Record<string, any> | null> =>
    page.evaluate(() => {
        const snapshots = (window as any).__syncSnapshots ?? [];
        return snapshots.length ? snapshots[snapshots.length - 1] : null;
    });

const stepKey = (snapshot: Record<string, any> | null): string =>
    snapshot ? `${snapshot.phase}|${snapshot.activeNightRole}|${snapshot.sheriffElectionDone}` : 'none';

async function advanceToDay(gm: Page, probe: Page): Promise<void> {
    for (let step = 0; step < 12; step++) {
        const current = await latestSnapshot(probe);
        if (current?.phase === 'DAY') return;

        const before = stepKey(current);
        await pressAdvance(gm);
        await expect
            .poll(async () => stepKey(await latestSnapshot(probe)), { message: `server did not move past ${before}` })
            .not.toBe(before);
    }
    throw new Error('the GM escape hatch never reached DAY');
}

async function pressAdvance(gm: Page): Promise<void> {
    await gm.locator('#manager-advance-btn').click();
    await gm.locator('#manager-advance-confirm-btn').click();
}

/** Four instrumented phones in the first night, phone 1 carrying the HTML name. */
async function fourPhonesWithHtmlName(browser: Browser): Promise<Phone[]> {
    const phones: Phone[] = [];
    for (let i = 0; i < 4; i++) {
        const phone = await newPhone(browser);
        await recordSnapshots(phone.page);
        phones.push(phone);
    }

    const gm = phones[0]!.page;
    const code = await createGame(gm);
    await setName(gm, 'Gamemaster');

    for (let i = 1; i < phones.length; i++) {
        await joinGame(phones[i]!.page, code);
        await setName(phones[i]!.page, i === 1 ? IMG_PAYLOAD : `Player ${i}`);
    }
    for (const { page } of phones) await expect(page.locator('#player-count')).toHaveText('4');

    await closeJoining(gm);
    await startActualGame(gm);
    for (const { page } of phones) await waitForNight(page);

    return phones;
}

test.describe('escaping', () => {
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

    test('a name with HTML renders as text in the lobby', async ({ browser }) => {
        const gm = await newPhone(browser);
        const player = await newPhone(browser);
        phones = [gm, player];
        phones.forEach(({ page }) => {
            collectPageErrors(page, pageErrors);
            failOnDialogs(page, dialogs);
        });

        const code = await createGame(gm.page);
        await setName(gm.page, 'Gamemaster');
        await joinGame(player.page, code);

        await setName(player.page, IMG_PAYLOAD);

        // The other phone sees the literal string, not an element.
        await expect(gm.page.locator('#lobby-players-list')).toContainText(IMG_PAYLOAD);
        expect(
            await gm.page.evaluate(
                () => document.querySelector('#lobby-players-list img, #lobby-players-list b') === null,
            ),
        ).toBe(true);
        expect(await injectedElementCount(gm.page)).toBe(0);
        await expect(player.page.locator('#my-name-input')).toHaveValue(IMG_PAYLOAD);
        expect(dialogs).toEqual([]);

        await setName(player.page, BOLD_PAYLOAD);

        await expect(gm.page.locator('#lobby-players-list')).toContainText(BOLD_PAYLOAD);
        expect(
            await gm.page.evaluate(
                () => document.querySelector('#lobby-players-list img, #lobby-players-list b') === null,
            ),
        ).toBe(true);
        await expect(player.page.locator('#my-name-input')).toHaveValue(BOLD_PAYLOAD);
        expect(dialogs).toEqual([]);
    });

    test('an HTML name stays inert outside the lobby', async ({ browser }) => {
        test.slow();

        phones = await fourPhonesWithHtmlName(browser);
        phones.forEach(({ page }) => {
            collectPageErrors(page, pageErrors);
            failOnDialogs(page, dialogs);
        });

        const gm = phones[0]!.page;
        const payloadPlayer = phones[1]!.page;
        await advanceToDay(gm, payloadPlayer);
        await waitUntilVisible(payloadPlayer, '#day-nomination-view');

        // Nothing anywhere in any document parsed the payload into an element.
        for (const { page } of phones) {
            expect(await injectedElementCount(page), 'no injected element on any phone').toBe(0);
        }
        await expect(gm.locator('#day-nomination-list')).toContainText(IMG_PAYLOAD);
        expect(dialogs).toEqual([]);

        // The death announcement interpolates names as well: put the payload player on
        // trial, vote them out with the GM escape hatch filling the other ballots.
        await gm.locator('#day-nomination-list .nomination-item').filter({ hasText: IMG_PAYLOAD }).click();
        await gm.locator('#confirm-nomination-btn').click();
        await pressAdvance(gm);
        await waitUntilVisible(gm, '#day-voting-view');

        await gm.locator('#day-vote-list .voting-item').filter({ hasText: IMG_PAYLOAD }).click();
        await gm.locator('#confirm-vote-btn').click();
        await pressAdvance(gm);
        await waitUntilVisible(gm, '#death-popup-overlay');

        await expect(gm.locator('#newly-dead-list')).toContainText(IMG_PAYLOAD);
        expect(await gm.locator('#newly-dead-list img, #newly-dead-list b').count()).toBe(0);
        for (const { page } of phones) {
            expect(await injectedElementCount(page), 'no injected element after the death popup').toBe(0);
        }
        expect(await isVisible(gm, '#death-popup-overlay')).toBe(true);
        expect(dialogs).toEqual([]);
    });
});
