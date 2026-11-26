import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import {
    closeJoining,
    closePhones,
    collectPageErrors,
    createGame,
    isVisible,
    joinGame,
    newPhone,
    readRoleCards,
    setName,
    startActualGame,
    voteForSheriff,
    waitForNight,
    waitForPointerReady,
    waitUntilVisible,
} from '../lib/flows';
import type { Phone } from '../lib/flows';

// The disconnection matrix. Reconnect.spec proves the single case "reload mid-game"; this
// file walks every phase with the realistic case: the phone loses its signal (offline),
// the transport dies, the socket.io client gets a NEW socket id on return and has to
// re-announce its seat (B15) and catch up on everything that happened while it was gone.
//
// Every test asserts three things, in this order:
//   1. the disconnect was REAL (browser offline, transport closed, app logged the drop,
//      reconnection attempts really failed),
//   2. the return is a rejoin, not a new seat (new socket id, re-emitted joinGame with the
//      same playerUUID, no reload),
//   3. the screen shows the CURRENT phase and the old view is gone.

const nameOf = (index: number): string => (index === 0 ? 'Gamemaster' : `Player ${index}`);

/** Display name from the role card -> Role enum member ("Red Lady" -> "RED_LADY"). */
const roleEnum = (display: string): string => display.trim().toUpperCase().replace(/\s+/g, '_');

/** A snapshot is the only thing a player ever sees: both the UI and these assertions use it. */
interface Snapshot {
    phase: string;
    activeNightRole: string | null;
    playerUUID: string;
    displayName: string;
    isManager: boolean;
    role: string | null;
    players: Array<{ playerUUID: string; displayName: string; isAlive: boolean }>;
    nominationsFinished?: boolean;
    lynchDone?: boolean;
    sheriffElectionDone?: boolean;
    readyForNight?: boolean;
    myVoteTargetUUID?: string | false | null;
    myNominationUUID?: string | false | null;
    winningTeam?: string | null;
    [key: string]: any;
}

interface ProbeState {
    sids: string[];
    sent: Array<{ name: string; payload: any }>;
    syncs: Snapshot[];
    closed: number;
    loads: number;
}

interface Table {
    code: string;
    gm: Page;
    seats: Phone[];
    /** Role display names as dealt to seats[i]. Random: never assume a seat. */
    roles: string[];
}

interface Offline {
    sid: string;
    playerUUID: string;
    sidCount: number;
    sentCount: number;
    syncs: number;
    loads: number;
}

// --- socket / network probe -------------------------------------------------------------
// Records what the page's own socket.io client does: the engine.io session id it is given,
// the events it emits, the snapshots it receives, and how often the page document loaded.
// The raw WebSocket instances are kept aside on window.__probeSockets so a test can drop
// the live transport from inside the page, which is what a phone losing signal does.

async function instrument(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const w = window as any;
        w.__probe = { sids: [], sent: [], syncs: [], closed: 0, loads: 0 };
        w.__probe.loads = Number(sessionStorage.getItem('__probeLoads') ?? '0') + 1;
        sessionStorage.setItem('__probeLoads', String(w.__probe.loads));

        const socketSockets: WebSocket[] = [];
        w.__probeSockets = socketSockets;

        const Native = window.WebSocket;
        class RecordingWebSocket extends Native {
            constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols);
                // Vite's HMR socket is not ours to observe or to drop.
                if (!String(url).includes('/socket.io/')) return;

                socketSockets.push(this);
                this.addEventListener('message', (event: MessageEvent) => {
                    if (typeof event.data !== 'string') return;
                    for (const packet of event.data.split('\x1e')) {
                        if (packet.startsWith('0{')) {
                            try {
                                w.__probe.sids.push(JSON.parse(packet.slice(1)).sid);
                            } catch {
                                // not an engine.io handshake
                            }
                        } else if (packet.startsWith('42')) {
                            try {
                                const [name, data] = JSON.parse(packet.slice(2));
                                if (name === 'syncState') w.__probe.syncs.push(data);
                            } catch {
                                // not a socket.io EVENTS frame
                            }
                        }
                    }
                });
                this.addEventListener('close', () => {
                    w.__probe.closed += 1;
                });
            }

            send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
                if (typeof data === 'string') {
                    for (const packet of data.split('\x1e')) {
                        if (!packet.startsWith('42')) continue;
                        try {
                            const [name, payload] = JSON.parse(packet.slice(2));
                            w.__probe.sent.push({ name, payload });
                        } catch {
                            // not a socket.io EVENTS frame
                        }
                    }
                }
                super.send(data as any);
            }
        }

        window.WebSocket = RecordingWebSocket as any;
    });
}

const probeState = (page: Page): Promise<ProbeState> =>
    page.evaluate(() => JSON.parse(JSON.stringify((window as any).__probe ?? { sids: [], sent: [], syncs: [], closed: 0, loads: 0 })));

async function snapshot(page: Page): Promise<Snapshot | null> {
    const state = await probeState(page);
    return state.syncs.length ? state.syncs[state.syncs.length - 1]! : null;
}

async function requireSnapshot(page: Page, message = 'the phone never received a snapshot'): Promise<Snapshot> {
    const snap = await snapshot(page);
    expect(snap, message).not.toBeNull();
    return snap!;
}

const stepKey = (snap: Snapshot | null): string =>
    snap
        ? [snap.phase, snap.activeNightRole, snap.lynchDone, snap.nominationsFinished, snap.sheriffElectionDone].join('|')
        : 'none';

// --- offline / online -------------------------------------------------------------------

/**
 * The bare network cut: the context really goes offline, the live socket.io transport is
 * dropped, and the test waits for the app itself to notice (its own console logs: the socket
 * disconnect plus a failed reconnection attempt). Works on any route, with or without a game,
 * because the start page needs the same proof without owning a snapshot.
 */
async function cutNetwork(seat: Phone): Promise<void> {
    const page = seat.page;
    await seat.context.setOffline(true);
    await expect
        .poll(() => page.evaluate(() => navigator.onLine), { message: 'the browser did not go offline' })
        .toBe(false);

    // What the radio does: the transport dies while the server keeps the seat.
    await page.evaluate(() => {
        const sockets = (window as any).__probeSockets as WebSocket[];
        const live = sockets.filter((socket) => socket.readyState === WebSocket.OPEN);
        if (!live.length) throw new Error('no live socket.io transport to drop');
        live[live.length - 1]!.close();
    });

    await expect
        .poll(async () => (await probeState(page)).closed, { message: 'the transport never actually closed' })
        .toBeGreaterThan(0);
    await expect
        .poll(() => consoleLines.some((line) => line.includes('Socket disconnected')), {
            message: 'the app never noticed that its socket died',
        })
        .toBe(true);
    // Reconnection attempts must really fail, otherwise "offline" would be theatre.
    await expect
        .poll(() => consoleLines.some((line) => line.includes('Socket connection error')), {
            message: 'the app kept reaching the server while it was offline',
        })
        .toBe(true);
}

/** Shape A: a seat inside a running game loses its signal. */
async function goOffline(table: Table, seat: Phone): Promise<Offline> {
    const page = seat.page;
    const before = await probeState(page);
    const snap = await requireSnapshot(page, 'no snapshot before the disconnect');
    const sid = before.sids[before.sids.length - 1];
    expect(sid, 'socket.io never completed a handshake on this phone').toBeTruthy();

    await cutNetwork(seat);

    return {
        sid: sid!,
        playerUUID: snap.playerUUID,
        sidCount: before.sids.length,
        sentCount: before.sent.length,
        syncs: before.syncs.length,
        loads: before.loads,
    };
}

/** Shape A, second half: the signal is back and the client must rejoin its old seat. */
async function comeBack(table: Table, seat: Phone, offline: Offline): Promise<void> {
    const page = seat.page;
    await seat.context.setOffline(false);

    await expect
        .poll(async () => (await probeState(page)).sids.length, {
            timeout: 20_000,
            message: 'socket.io never reconnected after the network came back',
        })
        .toBeGreaterThan(offline.sidCount);
    await expect
        .poll(async () => {
            const state = await probeState(page);
            return state.sids[state.sids.length - 1];
        }, { timeout: 20_000, message: 'the reconnect did not get a new socket id' })
        .not.toBe(offline.sid);

    const after = await probeState(page);
    expect(after.loads, 'a network blip must reconnect in place, not reload the document').toBe(offline.loads);

    const rejoin = after.sent.slice(offline.sentCount).filter((event) => event.name === 'joinGame');
    expect(rejoin.length, 'the reconnected client must re-emit joinGame with its stored seat').toBeGreaterThan(0);
    expect(rejoin[0]!.payload.gameId).toBe(table.code);
    expect(rejoin[0]!.payload.playerUUID).toBe(offline.playerUUID);

    await expect
        .poll(async () => (await probeState(page)).syncs.length, { message: 'no fresh snapshot arrived after the reconnect' })
        .toBeGreaterThan(offline.syncs);
}

/**
 * Bounded observation of a negative: while an actor is gone the game must not move on by
 * itself. The window is short and explicit; it fails immediately if the game did advance.
 */
async function expectNoAdvance(page: Page, keyBefore: string, windowMs = 1_500): Promise<void> {
    const moved = await page
        .waitForFunction(
            (before) => {
                const syncs = ((window as any).__probe?.syncs ?? []) as Snapshot[];
                const last = syncs[syncs.length - 1];
                if (!last) return false;
                return [last.phase, last.activeNightRole, last.lynchDone, last.nominationsFinished, last.sheriffElectionDone].join('|') !== before;
            },
            keyBefore,
            { timeout: windowMs, polling: 100 },
        )
        .then(() => true)
        .catch(() => false);
    expect(moved, 'the game advanced by itself while an actor was offline').toBe(false);
}

// --- table / phase driver ---------------------------------------------------------------

async function openTable(browser: Browser, count = 4): Promise<Table> {
    const seats: Phone[] = [];
    for (let i = 0; i < count; i++) {
        const seat = await newPhone(browser);
        await instrument(seat.page);
        watch(seat.page);
        seats.push(seat);
    }
    phones.push(...seats);

    const gm = seats[0]!.page;
    const code = await createGame(gm);
    await setName(gm, nameOf(0));
    for (let i = 1; i < count; i++) {
        await joinGame(seats[i]!.page, code);
        await setName(seats[i]!.page, nameOf(i));
    }
    for (const seat of seats) await expect(seat.page.locator('#player-count')).toHaveText(String(count));

    // The instruments have to be live before a disconnect can be proven.
    await expect
        .poll(async () => (await probeState(seats[1]!.page)).sids.length, { message: 'the probe never saw a socket handshake' })
        .toBeGreaterThan(0);

    return { code, gm, seats, roles: [] };
}

/** A started game: lobby -> role selection -> distribution -> night. */
async function startTable(browser: Browser, count = 4): Promise<Table> {
    const table = await openTable(browser, count);
    await waitForPointerReady(table.gm);
    await closeJoining(table.gm);
    table.roles = await readRoleCards(table.seats);
    await startActualGame(table.gm);
    for (const seat of table.seats) await waitForNight(seat.page);
    return table;
}

/**
 * One stage of the GM escape hatch. The confirm tap disables the button synchronously and
 * only the following snapshot re-arms it, so waiting for that is what keeps a spec from
 * reading (or advancing into) the previous stage.
 */
async function advanceOnce(gm: Page): Promise<void> {
    await waitForPointerReady(gm);
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
    await expect(advanceBtn).toBeEnabled();
}

/** Drives the escape hatch until the observed snapshot satisfies `done`. */
async function advanceUntil(
    table: Table,
    probe: Page,
    done: (snap: Snapshot) => boolean,
    maxSteps = 14,
): Promise<Snapshot> {
    for (let step = 0; step < maxSteps; step++) {
        const current = await snapshot(probe);
        if (current && done(current)) return current;
        const before = stepKey(current);
        await advanceOnce(table.gm);
        await expect
            .poll(async () => stepKey(await snapshot(probe)), { message: `the escape hatch did not move past ${before}` })
            .not.toBe(before);
    }
    const last = await snapshot(probe);
    if (last && done(last)) return last;
    throw new Error(`the escape hatch never reached the requested stage (last: ${stepKey(last)})`);
}

/** Nominates a living player by display name, or "No One" when `target` is null. */
async function nominate(page: Page, target: string | null): Promise<void> {
    const item = page.locator('#day-available-list li.nomination-item');
    const candidate = target ? item.filter({ hasText: target }) : item.filter({ hasText: 'Nominate No One' });
    await expect(candidate, `no nomination entry for ${target ?? 'No One'}`).toHaveCount(1);
    await candidate.click();
    await expect(candidate).toHaveClass(/selected/);
    const confirm = page.locator('#confirm-nomination-btn');
    await expect(confirm).toBeEnabled();
    await confirm.click();
}

async function voteFor(page: Page, target: string): Promise<void> {
    const candidate = page.locator('#day-vote-list li.voting-item').filter({ hasText: target });
    await expect(candidate, `no trial ballot for ${target}`).toHaveCount(1);
    await candidate.click();
    const confirm = page.locator('#confirm-vote-btn');
    await expect(confirm).toBeEnabled();
    await confirm.click();
}

/** The death announcement is a full-screen overlay; it would swallow the next tap. */
async function dismissDeaths(page: Page): Promise<void> {
    const overlay = page.locator('#death-popup-overlay');
    await expect(overlay).toBeVisible();
    await page.locator('#close-death-popup').click();
    await expect(overlay).toBeHidden();
}

/**
 * Cheapest legitimate route to GAME_OVER: escape-hatch through the unplayed night and the
 * election, put the only wolf on trial and vote it out for real (village win).
 */
async function lynchTheWolf(table: Table): Promise<number> {
    const wolfIndex = table.roles.findIndex((role) => roleEnum(role) === 'WEREWOLF');
    expect(wolfIndex, `the 4-player preset must deal a Wolf, roles were ${table.roles.join(', ')}`).toBeGreaterThanOrEqual(0);

    await advanceUntil(table, table.seats[1]!.page, (snap) => snap.phase === 'DAY');

    const nominatorIndex = table.roles.findIndex((role, index) => index !== wolfIndex);
    await nominate(table.seats[nominatorIndex]!.page, nameOf(wolfIndex));
    for (const [index, seat] of table.seats.entries()) {
        if (index === nominatorIndex) continue;
        await nominate(seat.page, null);
    }
    for (const seat of table.seats) await waitUntilVisible(seat.page, '#day-voting-view');
    for (const seat of table.seats) await voteFor(seat.page, nameOf(wolfIndex));

    for (const seat of table.seats) await waitUntilVisible(seat.page, '#final-roles-list');
    for (const seat of table.seats) await dismissDeaths(seat.page);
    return wolfIndex;
}

// --- bookkeeping ------------------------------------------------------------------------

let phones: Phone[] = [];
let pageErrors: string[] = [];
let dialogs: string[] = [];
let consoleLines: string[] = [];

// Only a deliberately triggered rejection may reach the user as an alert (that is how the
// app reports a refused action today), and only the network being down may log an error.
const ALLOWED_DIALOGS = /Only the game manager can advance the game/;
const NETWORK_LOGS = /Socket connection error|WebSocket connection to|ERR_INTERNET_DISCONNECTED|websocket error|Cannot reach the game server|Only the game manager can advance the game/;

function watch(page: Page): void {
    collectPageErrors(page, pageErrors, NETWORK_LOGS);
    page.on('console', (message) => consoleLines.push(message.text()));
    page.on('dialog', async (dialog) => {
        dialogs.push(`${dialog.type()}: ${dialog.message()}`);
        await dialog.dismiss().catch(() => undefined);
    });
}

test.describe('disconnect and reconnect by phase', () => {
    test.beforeEach(() => {
        phones = [];
        pageErrors = [];
        dialogs = [];
        consoleLines = [];
    });

    test.afterEach(async () => {
        await closePhones(phones);
        phones = [];
        expect(dialogs.filter((dialog) => !ALLOWED_DIALOGS.test(dialog)), 'the app must never open a blocking dialog').toEqual([]);
        expect(pageErrors, 'the page must not throw or log console errors').toEqual([]);
        pageErrors = [];
        dialogs = [];
        consoleLines = [];
    });

    test('LOBBY: a blip keeps the seat, the name and the count', async ({ browser }) => {
        test.slow();
        const table = await openTable(browser, 4);
        const player = table.seats[1]!;

        const offline = await goOffline(table, player);

        // The seat is only dropped from the socket mapping, never from the game.
        await expect(table.gm.locator('#player-count'), 'an offline seat must not vanish from the lobby').toHaveText('4');
        await expect(table.gm.locator('#lobby-players-list li').filter({ hasText: nameOf(1) })).toHaveCount(1);

        await comeBack(table, player, offline);

        await waitUntilVisible(player.page, '#lobby-players-list');
        await expect(player.page.locator('#my-name-input')).toHaveValue(nameOf(1));
        await expect(player.page.locator('#player-count')).toHaveText('4');
        // A newcomer would own no seat, an empty name and (if first) the manager badge.
        expect(await isVisible(player.page, '#role-selection-admin-ui')).toBe(false);
        await expect(player.page.locator('#my-player-slot')).toBeVisible();

        const snap = await requireSnapshot(player.page);
        expect(snap.phase).toBe('LOBBY');
        expect(snap.playerUUID).toBe(offline.playerUUID);
        expect(snap.isManager).toBe(false);
        expect(snap.players).toHaveLength(4);

        for (const seat of table.seats) await expect(seat.page.locator('#player-count')).toHaveText('4');
        await expect(table.gm.locator('#lobby-players-list li').filter({ hasText: nameOf(1) })).toHaveCount(1);
        // The lobby still works: the GM's only control is intact.
        await waitUntilVisible(table.gm, '#manager-controls');
    });

    test('ROLE_SELECTION: the returning phone still waits, and the GM can still distribute', async ({ browser }) => {
        test.slow();
        const table = await openTable(browser, 4);
        await waitForPointerReady(table.gm);
        await table.gm.locator('#start-game-btn').click();
        await waitUntilVisible(table.gm, '#role-selection-admin-ui');

        const player = table.seats[1]!;
        await waitUntilVisible(player.page, '#role-selection-waiting-ui');

        const offline = await goOffline(table, player);
        // While the phone is gone the GM keeps its own screen, no phase change is implied.
        await expect(table.gm.locator('#total-player-count')).toHaveText('4');
        await comeBack(table, player, offline);

        await waitUntilVisible(player.page, '#role-selection-waiting-ui');
        expect(await isVisible(player.page, '#role-selection-admin-ui')).toBe(false);

        const snap = await requireSnapshot(player.page);
        expect(snap.phase).toBe('ROLE_SELECTION');
        expect(snap.playerUUID).toBe(offline.playerUUID);
        expect(snap.isManager).toBe(false);
        expect(snap.players).toHaveLength(4);

        // Authority survived: the GM distributes and every seat, including the returning
        // one, gets a role card.
        await waitForPointerReady(table.gm);
        await table.gm.locator('#confirm-roles-btn').click();
        for (const seat of table.seats) {
            await expect(seat.page.locator('#role-name-display'), `seat ${seat.page.url()} got no role card`).not.toBeEmpty();
        }
        expect((await requireSnapshot(player.page)).phase).toBe('DISTRIBUTION');
    });

    test('DISTRIBUTION: the GM starts while a card is offline, and the card survives the return', async ({ browser }) => {
        test.slow();
        const table = await openTable(browser, 4);
        await waitForPointerReady(table.gm);
        await closeJoining(table.gm);
        const roles = await readRoleCards(table.seats);

        const player = table.seats[1]!;
        const roleBefore = (await requireSnapshot(player.page)).role;
        expect(roleBefore, 'no role was dealt to the seat under test').toBeTruthy();

        const offline = await goOffline(table, player);

        // What actually happens: distribution does not wait for an offline seat. The GM can
        // start the night; the deal already happened for all four seats.
        await startActualGame(table.gm);
        await waitForNight(table.gm);
        expect((await requireSnapshot(table.gm)).players, 'the deal must still cover every seat').toHaveLength(4);

        await comeBack(table, player, offline);

        // Catch-up: the phone that left on its role card comes back into the night.
        await waitForNight(player.page);
        expect(await isVisible(player.page, '#role-name-display'), 'the stale role card is still on screen').toBe(false);
        expect(await isVisible(player.page, '#distribution-waiting-message')).toBe(false);

        const snap = await requireSnapshot(player.page);
        expect(snap.phase).toBe('NIGHT');
        expect(snap.playerUUID).toBe(offline.playerUUID);
        expect(snap.role, 'the returning seat must keep the card it was dealt').toBe(roleBefore);
        expect(roleEnum(roles[1]!), 'the role card shown before the blip and the snapshot must agree').toBe(roleBefore);
        expect(snap.players).toHaveLength(4);
    });

    test('NIGHT: a bystander offline during another role turn returns to the same turn', async ({ browser }) => {
        test.slow();
        const table = await startTable(browser);
        const active = (await requireSnapshot(table.gm)).activeNightRole;
        // The 4-player preset opens with the pack, then the seer.
        expect(active, `the 4-player preset must open the night with the Werewolf, got ${active}`).toBe('WEREWOLF');

        const index = table.roles.findIndex((role, i) => i > 0 && roleEnum(role) !== active);
        if (index < 0) throw new Error(`no bystander to take offline, roles were ${table.roles.join(', ')}`);
        const bystander = table.seats[index]!;
        await waitUntilVisible(bystander.page, '#night-sleep-view');
        const roleBefore = (await requireSnapshot(bystander.page)).role;

        const offline = await goOffline(table, bystander);
        const whileAway = await requireSnapshot(table.gm);
        expect(whileAway.phase).toBe('NIGHT');
        expect(whileAway.activeNightRole, 'the sleeping phone had no business changing the turn').toBe(active);
        await expect(table.gm.locator('#manager-advance-btn')).toBeVisible();

        await comeBack(table, bystander, offline);

        await waitUntilVisible(bystander.page, '#night-sleep-view');
        expect(await isVisible(bystander.page, '#night-action-container'), 'a bystander must not wake up').toBe(false);

        const snap = await requireSnapshot(bystander.page);
        expect(snap.phase).toBe('NIGHT');
        expect(snap.activeNightRole).toBe(active);
        expect(snap.role).toBe(roleBefore);
        expect(snap.players).toHaveLength(4);

        // Exactly one seat with that name for the rest of the table.
        const gmSnap = await requireSnapshot(table.gm);
        expect(gmSnap.players.filter((entry) => entry.displayName === nameOf(index))).toHaveLength(1);
    });

    test('NIGHT: an offline actor is stale until the GM skips, and the return shows the new turn', async ({ browser }) => {
        test.slow();
        const table = await startTable(browser);
        const firstActive = (await requireSnapshot(table.gm)).activeNightRole!;
        let active = firstActive;
        // The GM must stay online: it is the only phone with the escape hatch. If the
        // manager happens to hold the first waking role, hand the night on once and use a
        // player's own turn instead.
        let index = table.roles.findIndex((role, i) => i > 0 && roleEnum(role) === active);
        if (index < 0) {
            await advanceOnce(table.gm);
            active = (await requireSnapshot(table.gm)).activeNightRole ?? 'none';
            index = table.roles.findIndex((role, i) => i > 0 && roleEnum(role) === active);
        }
        if (index < 0) throw new Error(`no player holds the active role ${active}, roles were ${table.roles.join(', ')}`);
        const actor = table.seats[index]!;
        await waitUntilVisible(actor.page, '#night-action-container');
        const roleBefore = (await requireSnapshot(actor.page)).role;

        const keyBefore = stepKey(await snapshot(table.gm));
        const offline = await goOffline(table, actor);

        // Their action is genuinely pending: nothing resolves behind their back.
        await expectNoAdvance(table.gm, keyBefore);
        expect(stepKey(await snapshot(table.gm)), 'the night resolved itself').toBe(keyBefore);

        // The only way out is the GM's escape hatch.
        await advanceOnce(table.gm);
        const skipped = await requireSnapshot(table.gm);
        expect(stepKey(skipped), 'the escape hatch moved nothing').not.toBe(keyBefore);

        await comeBack(table, actor, offline);

        expect(await isVisible(actor.page, '#night-action-container'), 'a skipped turn must not be offered again').toBe(false);

        const snap = await requireSnapshot(actor.page);
        expect(snap.role).toBe(roleBefore);
        expect(snap.players).toHaveLength(4);

        if (snap.phase === 'NIGHT') {
            // The next role is awake; the returning phone is on that turn, not its own.
            await waitUntilVisible(actor.page, '#night-sleep-view');
            expect(snap.activeNightRole, 'the returning phone is on the stage it left, not the current one').toBe(skipped.activeNightRole);
            expect(snap.activeNightRole).not.toBe(active);

            const nextIndex = table.roles.findIndex((role) => roleEnum(role) === skipped.activeNightRole);
            expect(nextIndex).toBeGreaterThanOrEqual(0);
            await waitUntilVisible(table.seats[nextIndex]!.page, '#night-action-container');
        } else {
            // Skipping the last waking role resolved the night: the returning phone has to
            // be past the night entirely, not stuck on its skipped turn.
            expect(snap.phase).toBe('SHERIFF_ELECTION');
            await waitUntilVisible(actor.page, '#sheriff-voting-view');
            expect(snap.activeNightRole).toBeNull();
        }
    });

    test('SHERIFF_ELECTION: the direct ballot survives a blip', async ({ browser }) => {
        test.slow();
        const table = await startTable(browser);
        await advanceUntil(table, table.seats[1]!.page, (snap) => snap.phase === 'SHERIFF_ELECTION');

        const player = table.seats[1]!;
        await waitUntilVisible(player.page, '#sheriff-voting-view');
        const roleBefore = (await requireSnapshot(player.page)).role;

        const offline = await goOffline(table, player);
        await expect(table.gm.locator('#sheriff-vote-list')).toBeVisible();
        await comeBack(table, player, offline);

        await waitUntilVisible(player.page, '#sheriff-voting-view');
        expect(await isVisible(player.page, '#sheriff-result-view')).toBe(false);

        const snap = await requireSnapshot(player.page);
        expect(snap.phase).toBe('SHERIFF_ELECTION');
        expect(snap.role).toBe(roleBefore);
        expect(snap.players).toHaveLength(4);
        expect(snap.myVoteTargetUUID ?? null, 'the rejoin must not invent a ballot').toBeNull();
        // Every living seat plus the abstain row; there is no nomination list any more.
        await expect(player.page.locator('#sheriff-vote-list li.selectable-player')).toHaveCount(5);
        await expect(player.page.locator('#sheriff-vote-list')).toContainText(`${nameOf(1)} (You)`);
        await expect(player.page.locator('#sheriff-vote-list')).toContainText('Abstain from Vote');
        for (const retired of ['#sheriff-nomination-view', '#sheriff-nomination-list', '#confirm-sheriff-nomination-btn']) {
            await expect(player.page.locator(retired)).toHaveCount(0);
        }

        // Continuity: the returning phone still owns its ballot and can spend it.
        await expect(player.page.locator('#sheriff-voting-controls')).toBeVisible();
        await expect(player.page.locator('#sheriff-vote-confirmed-message')).toBeHidden();
        await waitForPointerReady(player.page);
        await voteForSheriff(player.page, null);
        await expect(player.page.locator('#sheriff-vote-confirmed-message')).toBeVisible();
    });

    test('DAY nominations: the returning phone is in the current stage and can still nominate', async ({ browser }) => {
        test.slow();
        const table = await startTable(browser);
        await advanceUntil(table, table.seats[1]!.page, (snap) => snap.phase === 'DAY' && !snap.nominationsFinished);

        const player = table.seats[1]!;
        await waitUntilVisible(player.page, '#day-nomination-view');
        const roleBefore = (await requireSnapshot(player.page)).role;

        const offline = await goOffline(table, player);
        const whileAway = await requireSnapshot(table.gm);
        expect(whileAway.phase).toBe('DAY');

        await comeBack(table, player, offline);

        await waitUntilVisible(player.page, '#day-nomination-view');
        expect(await isVisible(player.page, '#day-voting-view')).toBe(false);
        expect(await isVisible(player.page, '#day-result-view')).toBe(false);

        const snap = await requireSnapshot(player.page);
        expect(snap.phase).toBe('DAY');
        expect(snap.nominationsFinished).toBe(false);
        expect(snap.lynchDone).toBe(false);
        expect(snap.role).toBe(roleBefore);
        expect(snap.players).toHaveLength(4);
        await expect(player.page.locator('#nomination-progress')).toHaveText('0/4 players have nominated');
        await expect(player.page.locator('#day-nominated-list')).toContainText('No one is on trial yet.');

        // Continuity: the returning phone can cast its nomination.
        await waitForPointerReady(player.page);
        await nominate(player.page, null);
        await expect(player.page.locator('#nomination-confirmed-message')).toBeVisible();
    });

    test('DAY trial: a pending vote is resolved as an abstain and the phone sees the result', async ({ browser }) => {
        test.slow();
        const table = await startTable(browser);
        await advanceUntil(table, table.seats[1]!.page, (snap) => snap.phase === 'DAY');

        // Somebody has to be on trial, otherwise there is no vote stage to be stuck in.
        await nominate(table.seats[2]!.page, nameOf(3));
        await advanceOnce(table.gm);
        for (const seat of table.seats) await waitUntilVisible(seat.page, '#day-voting-view');

        const player = table.seats[1]!;
        const roleBefore = (await requireSnapshot(player.page)).role;
        const keyBefore = stepKey(await snapshot(table.gm));

        const offline = await goOffline(table, player);
        // The rest of the table finishes the day while this vote is pending.
        await advanceOnce(table.gm);
        expect(stepKey(await snapshot(table.gm))).not.toBe(keyBefore);

        await comeBack(table, player, offline);

        // Catch-up, and the old screen is gone.
        await waitUntilVisible(player.page, '#day-result-view');
        expect(await isVisible(player.page, '#day-voting-view'), 'the stale ballot is still on screen').toBe(false);

        const snap = await requireSnapshot(player.page);
        expect(snap.phase).toBe('DAY');
        expect(snap.lynchDone).toBe(true);
        expect(snap.myVoteTargetUUID, 'a missing vote must be recorded as an abstain').toBe(false);
        expect(snap.role).toBe(roleBefore);
        expect(snap.players).toHaveLength(4);
        await expect(player.page.locator('#lynched-player-name')).toHaveText('No One');
    });

    test('DAY result: the returning phone can still ready up for the night', async ({ browser }) => {
        test.slow();
        const table = await startTable(browser);
        await advanceUntil(table, table.seats[1]!.page, (snap) => snap.phase === 'DAY');
        // All abstain -> the day resolves to "no one was lynched".
        await advanceOnce(table.gm);
        for (const seat of table.seats) await waitUntilVisible(seat.page, '#day-result-view');

        const player = table.seats[1]!;
        const roleBefore = (await requireSnapshot(player.page)).role;
        const offline = await goOffline(table, player);
        await comeBack(table, player, offline);

        await waitUntilVisible(player.page, '#day-result-view');
        expect(await isVisible(player.page, '#day-nomination-view')).toBe(false);

        const snap = await requireSnapshot(player.page);
        expect(snap.phase).toBe('DAY');
        expect(snap.lynchDone).toBe(true);
        expect(snap.readyForNight).toBe(false);
        expect(snap.role).toBe(roleBefore);
        expect(snap.players).toHaveLength(4);

        // Continuity: the ready button is still theirs to press...
        await waitForPointerReady(player.page);
        const ready = player.page.locator('#ready-for-night-btn');
        await expect(ready).toBeVisible();
        await ready.click();
        await waitUntilVisible(player.page, '#night-waiting-message');
        expect((await requireSnapshot(player.page)).readyForNight).toBe(true);

        // ...and the table moves on into the next night afterwards.
        await advanceOnce(table.gm);
        await waitForNight(player.page);
        expect((await requireSnapshot(player.page)).phase).toBe('NIGHT');
    });

    test('GAME_OVER: the summary survives a blip and still shows every seat', async ({ browser }) => {
        test.slow();
        const table = await startTable(browser);
        const wolfIndex = await lynchTheWolf(table);
        await expect(table.gm.locator('#winner-team-text')).toHaveText('The Village Wins!');

        const survivorIndex = [1, 2, 3].find((index) => index !== wolfIndex)!;
        const survivor = table.seats[survivorIndex]!;
        const roleBefore = (await requireSnapshot(survivor.page)).role;

        const offline = await goOffline(table, survivor);
        await expect(table.gm.locator('#final-roles-list')).toBeVisible();
        await comeBack(table, survivor, offline);

        await waitUntilVisible(survivor.page, '#final-roles-list');
        expect(await isVisible(survivor.page, '#day-result-view')).toBe(false);

        const snap = await requireSnapshot(survivor.page);
        expect(snap.phase).toBe('GAME_OVER');
        expect(snap.winningTeam).toBe('village');
        expect(snap.role, 'the summary must not lose the returning seat').toBe(roleBefore);
        expect(snap.players).toHaveLength(4);

        await expect(survivor.page.locator('#winner-team-text')).toHaveText('The Village Wins!');
        await expect(survivor.page.locator('#final-roles-list li')).toHaveCount(4);
        await expect(survivor.page.locator('#final-roles-list')).toContainText('Werewolf');
        await expect(survivor.page.locator('#final-roles-list')).toContainText(nameOf(wolfIndex));
    });

    test('hard reload mid-night returns to the same seat, role and phase', async ({ browser }) => {
        test.slow();
        const table = await startTable(browser);
        const player = table.seats[1]!;
        const before = await probeState(player.page);
        const seatBefore = (await requireSnapshot(player.page)).playerUUID;
        const roleBefore = (await requireSnapshot(player.page)).role;
        const phaseBefore = (await requireSnapshot(player.page)).phase;
        const activeBefore = (await requireSnapshot(player.page)).activeNightRole;

        await player.page.reload();
        await waitForNight(player.page);

        const snap = await requireSnapshot(player.page);
        expect(snap.playerUUID).toBe(seatBefore);
        expect(snap.role).toBe(roleBefore);
        expect(snap.phase).toBe(phaseBefore);
        expect(snap.activeNightRole).toBe(activeBefore);
        expect(snap.players).toHaveLength(4);
        await expect(player.page.locator('#game-error-view')).toBeHidden();
        expect(await isVisible(player.page, '#lobby-players-list')).toBe(false);

        // The reload really happened, and the fresh document re-announced the stored seat.
        const after = await probeState(player.page);
        expect(after.loads, 'the document did not actually reload').toBe(before.loads + 1);
        const rejoins = after.sent.filter((event) => event.name === 'joinGame');
        expect(rejoins.length).toBeGreaterThan(0);
        expect(rejoins[rejoins.length - 1]!.payload.playerUUID).toBe(seatBefore);

        const gmSnap = await requireSnapshot(table.gm);
        expect(gmSnap.players).toHaveLength(4);
        expect(gmSnap.players.filter((entry) => entry.displayName === nameOf(1))).toHaveLength(1);
    });

    test('a closed tab reopened in the same context keeps the seat and catches up', async ({ browser }) => {
        test.slow();
        const table = await startTable(browser);
        const player = table.seats[1]!;
        await advanceUntil(table, player.page, (snap) => snap.phase === 'DAY');
        await waitUntilVisible(player.page, '#day-nomination-view');

        const seatBefore = (await requireSnapshot(player.page)).playerUUID;
        const roleBefore = (await requireSnapshot(player.page)).role;

        await player.page.close();

        // localStorage (and thus playerUUID:<gameId>) lives in the context, not the tab.
        const reopened = await player.context.newPage();
        await instrument(reopened);
        watch(reopened);
        player.page = reopened;

        await reopened.goto(`/#/game/${table.code}`);

        // Catch-up over the whole cold path: server gate -> game page -> current stage.
        await waitUntilVisible(reopened, '#day-nomination-view');
        await expect(reopened.locator('#game-error-view')).toBeHidden();

        const snap = await requireSnapshot(reopened);
        expect(snap.phase).toBe('DAY');
        expect(snap.playerUUID).toBe(seatBefore);
        expect(snap.role).toBe(roleBefore);
        expect(snap.players).toHaveLength(4);

        // One seat, held by this tab and seen once by everybody else.
        await expect(reopened.locator('#day-available-list')).toContainText(`${nameOf(1)} (You)`);
        await expect(reopened.locator('#day-available-list .player-name').filter({ hasText: nameOf(1) })).toHaveCount(1);
        await expect(table.gm.locator('#day-available-list .player-name').filter({ hasText: nameOf(1) })).toHaveCount(1);
        expect((await requireSnapshot(table.gm)).players.filter((entry) => entry.displayName === nameOf(1))).toHaveLength(1);
    });

    test('the GM keeps its escape hatch across its own blip', async ({ browser }) => {
        test.slow();
        const table = await startTable(browser);
        const gmSeat = table.seats[0]!;
        const probe = table.seats[1]!.page;

        const keyBefore = stepKey(await snapshot(probe));
        const offline = await goOffline(table, gmSeat);

        // Players keep their own screen while the GM is gone; nothing is handed over.
        await expect(probe.locator('#manager-advance-view')).toBeHidden();

        await comeBack(table, gmSeat, offline);

        await waitUntilVisible(table.gm, '#manager-advance-view');
        await expect(table.gm.locator('#manager-advance-btn')).toBeVisible();
        expect((await requireSnapshot(table.gm)).isManager).toBe(true);
        expect((await requireSnapshot(table.gm)).players).toHaveLength(4);

        // The authority is not just painted: it works.
        await advanceOnce(table.gm);
        expect(stepKey(await snapshot(probe)), 'the returning GM could not advance the game').not.toBe(keyBefore);

        // ...and it is still only the GM's.
        for (const seat of table.seats.slice(1)) {
            expect(await isVisible(seat.page, '#manager-advance-view'), 'the escape hatch is not the GM-only control').toBe(false);
        }
    });

    test('a non-manager cannot advance the game while the GM is offline', async ({ browser }) => {
        test.slow();
        const table = await startTable(browser);
        const gmSeat = table.seats[0]!;
        const intruder = table.seats[1]!;

        const keyBefore = stepKey(await snapshot(intruder.page));
        const offline = await goOffline(table, gmSeat);

        // The control is not rendered for a player. Bypass the CSS and call the handlers,
        // which is what an "is the backend checking?" test has to do.
        expect(await isVisible(intruder.page, '#manager-advance-view')).toBe(false);
        await intruder.page.evaluate(() => {
            (document.getElementById('manager-advance-btn') as HTMLButtonElement | null)?.click();
            (document.getElementById('manager-advance-confirm-btn') as HTMLButtonElement | null)?.click();
        });

        // Refused, with a reason, and the game did not move.
        await expect
            .poll(() => consoleLines.some((line) => line.includes('Only the game manager can advance the game')), {
                message: 'the game manager check never rejected the foreign advance',
            })
            .toBe(true);
        await expectNoAdvance(intruder.page, keyBefore);
        expect(stepKey(await snapshot(intruder.page))).toBe(keyBefore);
        expect((await requireSnapshot(intruder.page)).isManager).toBe(false);

        // The rejection is about authority, not about the GM being away: the GM can do it.
        await comeBack(table, gmSeat, offline);
        await advanceOnce(table.gm);
        expect(stepKey(await snapshot(intruder.page)), 'the rejected step never happened').not.toBe(keyBefore);
    });

    test('connection banner: shown while the game is offline, gone once the snapshot is back', async ({ browser }) => {
        test.slow();
        const table = await startTable(browser);
        const player = table.seats[1]!;
        await waitForNight(player.page);

        // The element always exists; only its display is toggled.
        await expect(player.page.locator('#connection-banner')).toHaveCount(1);
        expect(await isVisible(player.page, '#connection-banner'), 'the banner must not be up while connected').toBe(false);

        const offline = await goOffline(table, player);

        // A lost socket must not look like "nobody has acted yet" any more.
        await waitUntilVisible(player.page, '#connection-banner');
        await expect(player.page.locator('#connection-banner')).toContainText('Reconnecting');

        await comeBack(table, player, offline);

        // Hidden again as soon as the reconnect landed, with the phase still on screen.
        await expect(player.page.locator('#connection-banner')).toBeHidden();
        await waitForNight(player.page);
    });

    test('connection banner: never shown on the start page, where no game is on screen', async ({ browser }) => {
        const phone = await newPhone(browser);
        phones.push(phone);
        await instrument(phone.page);
        watch(phone.page);

        await phone.page.goto('/');
        await expect(phone.page.locator('#create-game')).toBeVisible();

        // Same real cut: the socket dies and the app cannot reach the server. There is just
        // no game whose connection state the banner could report.
        await cutNetwork(phone);
        expect(
            await isVisible(phone.page, '#connection-banner'),
            'the banner must not appear before a game page exists',
        ).toBe(false);
        await expect(phone.page.locator('#create-game')).toBeVisible();
    });

    test('role chip: a player who was offline during distribution still learns their role', async ({ browser }) => {
        test.slow();
        const table = await openTable(browser, 4);
        await waitForPointerReady(table.gm);
        await closeJoining(table.gm);
        const dealt = (await readRoleCards(table.seats))[1]!;
        const player = table.seats[1]!;

        // The role card is the right affordance here; the chip would duplicate it.
        expect(await isVisible(player.page, '#my-role-chip'), 'the chip must not repeat the role card').toBe(false);

        const offline = await goOffline(table, player);
        // The GM starts without that seat, so the card is never seen by its owner.
        await startActualGame(table.gm);
        await waitForNight(table.gm);
        await comeBack(table, player, offline);

        await waitForNight(player.page);
        await waitUntilVisible(player.page, '#my-role-chip');
        await expect(player.page.locator('#my-role-chip-name')).toHaveText(dealt);
        expect((await requireSnapshot(player.page)).role).toBe(roleEnum(dealt));

        // Not an artefact of one page's memory: the same after a hard reload in that phase.
        await player.page.reload();
        await waitForNight(player.page);
        await waitUntilVisible(player.page, '#my-role-chip');
        await expect(player.page.locator('#my-role-chip-name')).toHaveText(dealt);
        expect(await isVisible(player.page, '#role-name-display'), 'the distribution card is long gone').toBe(false);
    });

    test('role chip: hidden where the role card or the summary is the right affordance', async ({ browser }) => {
        test.slow();
        const table = await openTable(browser, 4);
        for (const seat of table.seats) {
            expect(await isVisible(seat.page, '#my-role-chip'), 'the chip must not appear in the LOBBY').toBe(false);
        }

        await waitForPointerReady(table.gm);
        await table.gm.locator('#start-game-btn').click();
        await waitUntilVisible(table.gm, '#role-selection-admin-ui');
        for (const seat of table.seats) {
            expect(await isVisible(seat.page, '#my-role-chip'), 'the chip must not appear in ROLE_SELECTION').toBe(false);
        }

        await waitForPointerReady(table.gm);
        await table.gm.locator('#confirm-roles-btn').click();
        table.roles = await readRoleCards(table.seats);
        const dealt = table.roles[1]!;
        for (const seat of table.seats) {
            expect(await isVisible(seat.page, '#my-role-chip'), 'the chip must not appear on the role card').toBe(false);
        }

        await startActualGame(table.gm);
        for (const seat of table.seats) await waitForNight(seat.page);
        await waitUntilVisible(table.seats[1]!.page, '#my-role-chip');
        await expect(table.seats[1]!.page.locator('#my-role-chip-name')).toHaveText(dealt);

        // It also carries through the day, and disappears on the summary screen.
        await advanceUntil(table, table.seats[1]!.page, (snap) => snap.phase === 'DAY');
        await waitUntilVisible(table.seats[1]!.page, '#my-role-chip');
        await expect(table.seats[1]!.page.locator('#my-role-chip-name')).toHaveText(dealt);

        await lynchTheWolf(table);
        for (const seat of table.seats) {
            expect(await isVisible(seat.page, '#my-role-chip'), 'the summary screen lists every role already').toBe(false);
        }
    });
});
