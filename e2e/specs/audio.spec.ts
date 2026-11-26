import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import {
    closeJoining,
    closePhones,
    collectPageErrors,
    createGame,
    failOnDialogs,
    joinGame,
    newPhone,
    readRoleCards,
    setName,
    startActualGame,
    waitForNight,
    waitUntilVisible,
} from '../lib/flows';
import type { Phone } from '../lib/flows';

// The audio dimension: AGENTS.md promises that narration (/narration/*.mp3) and the
// looping atmosphere (/sounds/atmosphere/*.mp3) only ever play on the Game Manager's
// phone, while SFX (/sounds/sfx/*.mp3) may play on everyone. No browser spec has ever
// looked at this, so these tests instrument the global `Audio` constructor before the
// app loads and assert on the routing decision, not on sound coming out of a speaker.
//
// Headless chromium may refuse autoplay. That is fine: the wrapper records the src at
// the moment `play()` is called, which is exactly the decision under test, and the
// app's own `.catch(console.warn)` keeps a refusal from becoming a page error.

interface InstrumentOptions {
    /** Make every play() reject with NotAllowedError, as a blocked-autoplay browser would. */
    blockAudio?: boolean;
}

/** Wraps `Audio` (and records syncState) before any app module runs. */
async function instrument(page: Page, options: InstrumentOptions = {}): Promise<void> {
    await page.addInitScript(({ blockAudio }) => {
        const w = window as any;
        w.__audioPlays = [];
        w.__syncSnapshots = [];

        const NativeAudio = window.Audio;
        const instrumentElement = (el: any): any => {
            const nativePlay = el.play.bind(el);
            el.play = () => {
                // Record before calling play(): a blocked play() still tells us which
                // file this phone *decided* to play. That decision is the contract.
                w.__audioPlays.push(el.src || '');
                if (blockAudio) {
                    return Promise.reject(new DOMException('blocked by test', 'NotAllowedError'));
                }
                return nativePlay();
            };
            return el;
        };
        // The app calls `new Audio()` / `new Audio(src)`. A plain function that returns a
        // real HTMLAudioElement keeps every other behaviour (loop, volume, onended) intact.
        function InstrumentedAudio(this: any, src?: string): any {
            return instrumentElement(src === undefined ? new NativeAudio() : new NativeAudio(src));
        }
        InstrumentedAudio.prototype = NativeAudio.prototype;
        w.Audio = InstrumentedAudio;

        // A snapshot counter is the honest barrier for "has this rejoin reached the GM?".
        // Copies the recorder from reconnect.spec.ts: engine.io may pack packets.
        const NativeWebSocket = window.WebSocket;
        class RecordingWebSocket extends NativeWebSocket {
            constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols);
                this.addEventListener('message', (event) => {
                    if (typeof event.data !== 'string') return;
                    for (const packet of event.data.split('\x1e')) {
                        if (!packet.startsWith('42')) continue;
                        try {
                            const [name, data] = JSON.parse(packet.slice(2));
                            if (name === 'syncState') w.__syncSnapshots.push(data);
                        } catch {
                            // not a socket.io EVENTS frame
                        }
                    }
                });
            }
        }
        window.WebSocket = RecordingWebSocket as any;
    }, { blockAudio: !!options.blockAudio });
}

const playUrls = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__audioPlays ?? []);

/** Full play() URLs reduced to pathnames, which is what the routing contract talks about. */
const playPaths = async (page: Page): Promise<string[]> => {
    const urls = await playUrls(page);
    return urls
        .map((raw) => {
            try {
                return new URL(raw).pathname;
            } catch {
                return '';
            }
        })
        .filter((path) => path !== '');
};

const snapshotCount = (page: Page): Promise<number> =>
    page.evaluate(() => ((window as any).__syncSnapshots ?? []).length);

const narrationOf = (paths: string[]): string[] => paths.filter((p) => p.startsWith('/narration/'));
const atmosphereOf = (paths: string[]): string[] => paths.filter((p) => p.startsWith('/sounds/atmosphere/'));
const sfxOf = (paths: string[]): string[] => paths.filter((p) => p.startsWith('/sounds/sfx/'));

interface AudioGame {
    phones: Phone[];
    gm: Page;
    roles: string[];
}

/** Creates instrumented phones and walks them into an open lobby. */
async function openLobby(
    browser: Browser,
    count: number,
    options: InstrumentOptions = {},
    onPhone?: (phone: Phone) => void,
): Promise<AudioGame & { code: string }> {
    const phones: Phone[] = [];
    for (let i = 0; i < count; i++) {
        const phone = await newPhone(browser);
        await instrument(phone.page, options);
        onPhone?.(phone);
        phones.push(phone);
    }

    const gm = phones[0]!.page;
    const code = await createGame(gm);
    await setName(gm, 'Gamemaster');
    for (let i = 1; i < phones.length; i++) {
        await joinGame(phones[i]!.page, code);
        await setName(phones[i]!.page, `Player ${i}`);
    }
    for (const { page } of phones) await expect(page.locator('#player-count')).toHaveText(String(count));

    return { phones, gm, roles: [], code };
}

/** openLobby -> distribution -> night, without touching the role cards. */
async function startNight(browser: Browser, count: number, onPhone?: (phone: Phone) => void): Promise<AudioGame> {
    const game = await openLobby(browser, count, {}, onPhone);
    await closeJoining(game.gm);
    const roles = await readRoleCards(game.phones);
    await startActualGame(game.gm);
    for (const { page } of game.phones) await waitForNight(page);
    return { phones: game.phones, gm: game.gm, roles };
}

/** One GM escape-hatch stage; re-arms only after the next snapshot. */
async function advanceOnce(gm: Page): Promise<void> {
    const advanceBtn = gm.locator('#manager-advance-btn');
    await expect(advanceBtn).toBeEnabled();
    await advanceBtn.click();
    await gm.locator('#manager-advance-confirm-btn').click();
    await expect(gm.locator('#manager-advance-confirm')).toBeHidden();
    await expect(advanceBtn).toBeEnabled();
}

test.describe('audio', () => {
    let phones: Phone[] = [];
    let pageErrors: string[] = [];
    let dialogs: string[] = [];

    const watch = (opened: Phone | Phone[]): void => {
        for (const phone of Array.isArray(opened) ? opened : [opened]) {
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

    test('narration: the wake-up lines only play on the game manager', async ({ browser }) => {
        test.slow();

        const game = await startNight(browser, 4, watch);
        phones = game.phones;

        // The GM runs the night, so the first wake-up line has to be attempted there.
        await expect
            .poll(async () => narrationOf(await playPaths(game.gm)).length, {
                timeout: 15_000,
                message: 'the game manager never attempted a narration line',
            })
            .toBeGreaterThan(0);

        for (const [index, phone] of game.phones.entries()) {
            if (index === 0) continue;
            const paths = await playPaths(phone.page);
            expect(narrationOf(paths), `player ${index} must never hear narration`).toEqual([]);
        }

        // Issue #18 claims non-GM devices play "random sounds". Measured here: the SFX
        // channel produces nothing at all, on any phone, because playSFX has no call
        // sites in the frontend. If that ever changes, this catches a missing managerOnly.
        const allPaths = (await Promise.all(game.phones.map((phone) => playPaths(phone.page)))).flat();
        expect(sfxOf(allPaths), 'SFX leaked to a phone; every playSFX call needs managerOnly where the sound is diegetic').toEqual([]);
    });

    test('atmosphere: only the game manager gets the looping background', async ({ browser }) => {
        test.slow();

        const game = await startNight(browser, 4, watch);
        phones = game.phones;

        await expect
            .poll(async () => atmosphereOf(await playPaths(game.gm)).length, {
                timeout: 15_000,
                message: 'the game manager never started an atmosphere track',
            })
            .toBeGreaterThan(0);

        for (const [index, phone] of game.phones.entries()) {
            if (index === 0) continue;
            expect(atmosphereOf(await playPaths(phone.page)), `player ${index} must never hear the atmosphere`).toEqual([]);
        }
    });

    test('narration: a re-synced night does not restart the line', async ({ browser }) => {
        test.slow();

        const game = await startNight(browser, 4, watch);
        phones = game.phones;

        await expect
            .poll(async () => narrationOf(await playPaths(game.gm)).length, {
                timeout: 15_000,
                message: 'no narration line fired in the first place',
            })
            .toBeGreaterThan(0);
        const before = await playPaths(game.gm);

        // Two rejoins, each broadcasting a fresh snapshot to the whole table. The night
        // phase (and its active role) does not change, so not one line may restart.
        for (const phone of game.phones.slice(1, 3)) {
            const barrier = await snapshotCount(game.gm);
            await phone.page.reload();
            await waitForNight(phone.page);
            await expect
                .poll(() => snapshotCount(game.gm), { message: 'the rejoin never reached the game manager' })
                .toBeGreaterThan(barrier);
        }
        expect(await playPaths(game.gm), 'a re-sync must not re-announce the active role').toEqual(before);

        // A real role change may start that turn's lines, but never the whole night again.
        const beforeAdvance = await playPaths(game.gm);
        const snapshotsBeforeAdvance = await snapshotCount(game.gm);
        await advanceOnce(game.gm);
        await expect.poll(() => snapshotCount(game.gm)).toBeGreaterThan(snapshotsBeforeAdvance);
        const added = (await playPaths(game.gm)).slice(beforeAdvance.length);
        expect(added.length, `one advance restarted too much audio: ${added.join(', ')}`).toBeLessThanOrEqual(2);
    });

    test('before the game nothing plays, the game-start line is GM-only, and blocked autoplay does not break the UI', async ({ browser }) => {
        test.slow();

        // Every phone blocks playback, so the catch handlers in AudioService are exercised.
        for (let i = 0; i < 4; i++) {
            const phone = await newPhone(browser);
            await instrument(phone.page, { blockAudio: true });
            phones.push(phone);
        }
        watch(phones);
        const gm = phones[0]!.page;

        // Nothing is scheduled before a game exists: the start page is silent.
        await gm.goto('/');
        await waitUntilVisible(gm, '#create-game');
        await gm.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        expect(await playPaths(gm), 'the start page must be silent').toEqual([]);

        const code = await createGame(gm);
        await setName(gm, 'Gamemaster');
        for (let i = 1; i < phones.length; i++) {
            await joinGame(phones[i]!.page, code);
            await setName(phones[i]!.page, `Player ${i}`);
        }
        await expect(gm.locator('#player-count')).toHaveText('4');
        expect(await playPaths(gm), 'the lobby must be silent').toEqual([]);

        // The first line of the game fires on the distribution card.
        await closeJoining(gm);
        await readRoleCards(phones);
        await expect
            .poll(async () => narrationOf(await playPaths(gm)).includes('/narration/game_start.mp3'), {
                timeout: 15_000,
                message: 'the game_start narration was never attempted on the manager',
            })
            .toBe(true);

        for (const [index, phone] of phones.entries()) {
            if (index === 0) continue;
            expect(narrationOf(await playPaths(phone.page)), `player ${index} must not hear game_start`).toEqual([]);
        }

        // A rejected play() is caught and only warns; the cards still render.
        for (const { page } of phones) {
            await expect(page.locator('#role-name-display')).not.toBeEmpty();
            await expect(page.locator('#game-error-view')).toBeHidden();
        }
    });

    test('a phone that left the game page stays silent although it still receives snapshots', async ({ browser }) => {
        test.slow();

        const game = await startNight(browser, 4, watch);
        phones = game.phones;

        await expect.poll(async () => (await playPaths(game.gm)).length).toBeGreaterThan(0);
        const beforeLeaving = await playPaths(game.gm);

        // Same-document navigation: the socket stays in the room, so the phone keeps
        // receiving snapshots, but StartPage is on screen and must not make a sound.
        await game.gm.evaluate(() => {
            window.location.hash = '/';
        });
        await waitUntilVisible(game.gm, '#create-game');
        const afterLeaving = await snapshotCount(game.gm);

        // A rejoining player makes the server broadcast to everyone, including this phone.
        await phones[1]!.page.reload();
        await waitForNight(phones[1]!.page);
        await expect
            .poll(() => snapshotCount(game.gm), { message: 'the start page stopped receiving snapshots' })
            .toBeGreaterThan(afterLeaving);

        expect(await playPaths(game.gm), 'a phone on the start page must stay silent').toEqual(beforeLeaving);
    });
});
