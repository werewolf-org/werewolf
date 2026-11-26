import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client, TestGame } from './harness.js';
import type { Snapshot } from './harness.js';
import { Phase } from '@shared/phases.js';
import { Role } from '@shared/roles.js';
import { GameStore } from '../../store/game.store.js';

// Adversarial rejoin cases for `GameManager.socketSeats` / `seatSockets`.
//
// The contract under attack: a seat may be held by several live sockets at once. Every
// one of them gets the same tailored snapshot, any one of them may act, and a seat is
// only released when its *last* socket is gone. A socket belongs to exactly one seat;
// switching seats (or games) must not leave the old seat bound, because a bound seat
// keeps receiving that game's snapshots and never looks disconnected again.
//
// Assertions are on tailored snapshots wherever a phone could see the difference. The
// two bookkeeping checks read the GameStore directly: a released seat produces no
// snapshot at all, so "player.socketId is null after the last close" is invisible on
// the wire.

// 1 wolf + 3 villagers: the shortest night (wolf vote -> dawn), so day-phase tests stay
// cheap. The wolf is derived from snapshots, never assumed.
const ONE_WOLF: Record<string, number> = {
    [Role.WEREWOLF]: 1,
    [Role.VILLAGER]: 3,
};

// Only wolves alive after the first night -> GAME_OVER.
const ALL_WOLVES: Record<string, number> = {
    [Role.WEREWOLF]: 3,
    [Role.VILLAGER]: 1,
};

// A full night order without Cupid, so the werewolf turn can hand over to the seer.
const NIGHT_ROLES: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.SEER]: 1,
    [Role.WITCH]: 1,
    [Role.VILLAGER]: 2,
};

let game: TestGame | null = null;
// Sockets that are not in `game.clients` (second tabs, rejoined clients, strangers).
// Closed in afterEach so a failing assertion never leaks a connection into the next test.
const extras: Client[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    extras.forEach((client) => client.close());
    extras.length = 0;
    await game?.close();
    game = null;
});

// --- helpers ---------------------------------------------------------------

const connected = (g: TestGame): Client[] => g.clients.filter((c) => c.socket.connected);

/** The one client holding `role`. Fails the test if the count is not exactly one. */
function only(g: TestGame, role: Role): Client {
    const found = g.clientsWithRole(role);
    expect(found.length, `expected exactly one client with role ${role}`).toBe(1);
    return found[0]!;
}

/** Opens a second live socket and binds it to an existing seat. */
async function openSocketFor(g: TestGame, playerUUID: string): Promise<Client> {
    const client = await Client.connect(g.server.url);
    extras.push(client);
    client.socket.emit('joinGame', { gameId: g.gameId, playerUUID });
    await client.waitFor((s) => s.playerUUID === playerUUID, 'second socket bound to the seat');
    return client;
}

/** Waits for a snapshot newer than the one the client already holds. */
function waitForNewSnapshot(client: Client, label: string): Promise<Snapshot> {
    const before = client.history.length;
    return client.waitFor(() => client.history.length > before, label);
}

/** Emits and resolves with the first rejection seen on any of `clients`. */
function nextError(clients: Client[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
            clients.forEach((c) => c.socket.off('error', onError));
            reject(new Error('Timed out after 2000ms waiting for a rejection'));
        }, 2000);
        const onError = (data: { message: string }) => {
            clearTimeout(timer);
            clients.forEach((c) => c.socket.off('error', onError));
            resolve(data.message);
        };
        clients.forEach((c) => c.socket.on('error', onError));
    });
}

/** Emits a deliberately rejected event and resolves with the server's message. */
async function emitExpectError(client: Client, event: string, payload: unknown, label: string): Promise<string> {
    const wait = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`Timed out after 2000ms waiting for an error after "${label}"`)),
            2000,
        );
        const onError = (data: { message: string }) => {
            clearTimeout(timer);
            client.socket.off('error', onError);
            resolve(data.message);
        };
        client.socket.on('error', onError);
    });
    client.socket.emit(event, payload);
    return wait;
}

/** Emits `managerAdvance` and waits until the manager's own snapshot matches. */
async function advance(g: TestGame, predicate: (s: Snapshot) => boolean, label: string): Promise<void> {
    const waiter = g.manager.waitFor(predicate, label);
    g.manager.socket.emit('managerAdvance', { gameId: g.gameId });
    await waiter;
}

async function rename(g: TestGame, client: Client, name: string): Promise<void> {
    client.socket.emit('changeName', { gameId: g.gameId, playerName: name });
    await client.waitFor((s) => s.displayName === name, `renamed to ${name}`);
}

/**
 * The part of a snapshot every player must agree on. Secrets (own role, potions,
 * werewolf votes, seer reveal) are deliberately excluded: those are per seat.
 */
function publicView(s: Snapshot): string {
    return JSON.stringify({
        gameId: s.gameId,
        phase: s.phase,
        activeNightRole: s.activeNightRole,
        players: s.players,
        lynchDone: s.lynchDone,
        sheriffElectionDone: s.sheriffElectionDone,
        winningTeam: s.winningTeam,
        votedOutUUID: s.votedOutUUID,
        nominationsFinished: s.nominationsFinished,
        voteResults: s.voteResults,
        voteProgress: s.voteProgress,
    });
}

function expectSamePublicView(clients: Client[], label: string): void {
    const live = clients.filter((c) => c.socket.connected && c.state);
    expect(live.length).toBeGreaterThan(0);
    const reference = publicView(live[0]!.state!);
    for (const client of live.slice(1)) {
        expect(publicView(client.state!), `${label}: ${client.playerUUID}@${client.socket.id} disagrees with the rest`).toBe(reference);
    }
}

/**
 * Kills one villager during night 0, which ends the night because no other role wakes.
 * The GM is never the victim, so the escape hatch stays reachable from a live socket.
 */
async function killOneVillager(g: TestGame): Promise<Client> {
    await Promise.all(connected(g).map((c) => c.waitForTurn(Role.WEREWOLF)));
    const wolf = only(g, Role.WEREWOLF);
    const victim = g.aliveClients().find((c) => c !== wolf && c !== g.manager)!;
    wolf.socket.emit('werewolfVote', { gameId: g.gameId, targetUUID: victim.playerUUID });
    await g.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);
    return victim;
}

/** Resolves the (empty) sheriff election and moves to DAY through the GM escape hatch. */
async function advanceToDay(g: TestGame): Promise<void> {
    await advance(g, (s) => s.phase === Phase.SHERIFF_ELECTION && s.sheriffElectionDone, 'sheriff election resolved');
    await advance(g, (s) => s.phase === Phase.DAY, 'day started');
    await g.waitForPhaseEverywhere(Phase.DAY);
}

/** Nominates `nomineeUUID` once, abstains for everybody else, waits for the stage to close. */
async function finishNominations(g: TestGame, nomineeUUID: string): Promise<void> {
    const alive = g.aliveClients().filter((c) => c.socket.connected);
    const done = connected(g).map((c) => c.waitFor((s) => s.nominationsFinished, 'nominations finished'));
    alive.forEach((client, index) => {
        client.socket.emit('nominate', {
            gameId: g.gameId,
            nominationUUID: index === 0 ? nomineeUUID : false,
        });
    });
    await Promise.all(done);
}

/** Lynches `target`: one nomination, then every living seat votes for it. */
async function lynch(g: TestGame, target: Client): Promise<void> {
    await finishNominations(g, target.playerUUID!);
    const voters = g.aliveClients().filter((c) => c.socket.connected);
    const done = connected(g).map((c) => c.waitFor((s) => s.lynchDone, 'lynch resolved'));
    for (const voter of voters) {
        voter.socket.emit('vote', { gameId: g.gameId, voteTargetUUID: target.playerUUID });
    }
    await Promise.all(done);
}

/** Starts a second game on the same server (same GameStore, same GameManager). */
async function createSecondGame(g: TestGame): Promise<{ gameId: string; host: Client }> {
    const host = await Client.connect(g.server.url);
    extras.push(host);

    const created = new Promise<{ gameId: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('second game was not created')), 5000);
        host.socket.once('gameCreated', (data: { gameId: string }) => {
            clearTimeout(timer);
            resolve(data);
        });
    });
    host.socket.emit('createGame');
    const { gameId } = await created;

    host.socket.emit('joinGame', { gameId, playerUUID: null });
    await host.waitFor((s) => s.gameId === gameId && s.playerUUID !== null, 'second game host joined');
    return { gameId, host };
}

/**
 * The seat's primary socket as the server holds it. `null` means the seat is released,
 * 'NO-PLAYER' means the game or seat is gone; the two must not be confused, which is why
 * this does not use `??` (that would collapse a released seat into a missing one).
 */
const storedSocketId = (gameId: string, playerUUID: string): string | null | 'NO-PLAYER' => {
    const player = GameStore.getInstance().getGame(gameId)?.players.find((p) => p.playerUUID === playerUUID);
    return player ? player.socketId : 'NO-PLAYER';
};

// --- tests -----------------------------------------------------------------

describe('one seat, several sockets: the same action twice in one turn', () => {
    it('accepts one nomination from a two-socket seat and rejects the duplicate', async () => {
        game = await TestGame.create({ playerCount: 4 });
        await game.setupAndStart(ONE_WOLF);
        await killOneVillager(game);
        await advanceToDay(game);

        const alive = game.aliveClients();
        const seat = alive.find((c) => c.state!.role === Role.VILLAGER)!;
        // Two different, stale-UI targets: whichever lands first must win outright, not be
        // merged into a "both nominated" state or silently dropped.
        const targets = alive.filter((c) => c !== seat).slice(0, 2);
        expect(targets).toHaveLength(2);
        const seatUUID = seat.playerUUID!;
        const second = await openSocketFor(game, seatUUID);

        const rejection = nextError([seat, second]);
        seat.socket.emit('nominate', { gameId: game.gameId, nominationUUID: targets[0]!.playerUUID });
        second.socket.emit('nominate', { gameId: game.gameId, nominationUUID: targets[1]!.playerUUID });
        const message = await rejection;

        expect(message).toMatch(/already has a nomination/);
        expect(seat.errors.length + second.errors.length).toBe(1);
        expect(seat.state).toEqual(second.state);
        const applied = seat.state!.myNominationUUID;
        expect([targets[0]!.playerUUID, targets[1]!.playerUUID]).toContain(applied);
        expect(seat.state!.players.filter((p) => typeof p.nomination === 'string')).toHaveLength(1);
        expect(seat.state!.players.filter((p) => p.playerUUID === seatUUID)).toHaveLength(1);

        await Promise.all(connected(game).map((c) => c.waitFor(
            (s) => s.players.find((p) => p.playerUUID === seatUUID)?.nomination === applied,
            'everyone saw the nomination',
        )));
        expectSamePublicView(connected(game), 'after the double nomination');
    });

    it('accepts one vote from a two-socket seat and resolves the lynch once', async () => {
        game = await TestGame.create({ playerCount: 4 });
        await game.setupAndStart(ONE_WOLF);
        await killOneVillager(game);
        await advanceToDay(game);

        const alive = game.aliveClients();
        const seat = alive.find((c) => c.state!.role === Role.VILLAGER)!;
        // A villager is lynched on purpose, so the game has to carry on to the next night.
        const target = alive.find((c) => c !== seat && c.state!.role !== Role.WEREWOLF)!;
        const second = await openSocketFor(game, seat.playerUUID!);
        await finishNominations(game, target.playerUUID!);

        const rejection = nextError([seat, second]);
        const resolved = connected(game).map((c) => c.waitFor((s) => s.lynchDone, 'lynch resolved'));
        for (const voter of alive.filter((c) => c !== seat)) {
            voter.socket.emit('vote', { gameId: game.gameId, voteTargetUUID: target.playerUUID });
        }
        seat.socket.emit('vote', { gameId: game.gameId, voteTargetUUID: target.playerUUID });
        second.socket.emit('vote', { gameId: game.gameId, voteTargetUUID: target.playerUUID });
        const message = await rejection;
        await Promise.all(resolved);

        expect(message).toMatch(/already voted/);
        expect(seat.errors.length + second.errors.length).toBe(1);
        expect(seat.state).toEqual(second.state);
        expect(seat.state!.lynchDone).toBe(true);
        expect(seat.state!.votedOutUUID).toBe(target.playerUUID);

        await Promise.all(connected(game).map((c) => c.waitFor(
            (s) => s.players.find((p) => p.playerUUID === target.playerUUID)?.isAlive === false,
            'the lynched player is dead everywhere',
        )));
        expectSamePublicView(connected(game), 'after the double vote');
    });

    it('accepts one readyForNight from a two-socket seat and starts exactly one night', async () => {
        game = await TestGame.create({ playerCount: 4 });
        await game.setupAndStart(ONE_WOLF);
        await killOneVillager(game);
        await advanceToDay(game);

        const alive = game.aliveClients();
        const seat = alive.find((c) => c.state!.role === Role.VILLAGER)!;
        const target = alive.find((c) => c !== seat && c.state!.role !== Role.WEREWOLF)!;
        const second = await openSocketFor(game, seat.playerUUID!);
        await lynch(game, target);

        // Only the seat is left to confirm, so the first readyForNight ends the day.
        const others = game.aliveClients().filter((c) => c !== seat);
        expect(others.length).toBeGreaterThan(0);
        for (const other of others) {
            other.socket.emit('readyForNight', { gameId: game.gameId });
            await other.waitFor((s) => s.readyForNight, 'other seat ready');
        }
        expect(seat.state!.phase).toBe(Phase.DAY);

        const rejection = nextError([seat, second]);
        const night = connected(game).map((c) => c.waitForPhase(Phase.NIGHT));
        seat.socket.emit('readyForNight', { gameId: game.gameId });
        second.socket.emit('readyForNight', { gameId: game.gameId });
        const message = await rejection;
        await Promise.all(night);
        await second.waitForPhase(Phase.NIGHT);

        expect(message).toMatch(/not currently in Day Phase/);
        expect(seat.errors.length + second.errors.length).toBe(1);
        expect(seat.state).toEqual(second.state);

        // A second startNight would have advanced the round twice.
        const stored = GameStore.getInstance().getGame(game.gameId)!;
        expect(stored.round).toBe(1);
        expect(stored.phase).toBe(Phase.NIGHT);
        expectSamePublicView(connected(game), 'after the double readyForNight');
    });
});

describe('rejoin while the night turn is advancing', () => {
    it('gives the rejoined socket the new turn, the same seat and refuses the stale action', async () => {        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(NIGHT_ROLES);
        await Promise.all(connected(game).map((c) => c.waitForTurn(Role.WEREWOLF)));

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        expect(wolves).toHaveLength(2);
        const wolf = wolves[0]!;
        const otherWolf = wolves[1]!;
        const victim = game.clientsWithRole(Role.VILLAGER)[0]!;
        const wolfUUID = wolf.playerUUID!;

        wolf.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: victim.playerUUID });
        await wolf.waitFor((s) => s.werewolfVotes?.[wolfUUID] === victim.playerUUID, 'first wolf vote recorded');

        // Rejoin in the same event-loop turn in which the pack's second vote advances the
        // night from WEREWOLF to SEER: whichever order the server sees them in, the socket
        // must end up bound to the seat and looking at the *current* turn.
        const rejoined = await Client.connect(game.server.url);
        extras.push(rejoined);
        const bound = rejoined.waitFor((s) => s.playerUUID === wolfUUID, 'rejoined seat');
        otherWolf.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: victim.playerUUID });
        rejoined.socket.emit('joinGame', { gameId: game.gameId, playerUUID: wolfUUID });
        await bound;

        await Promise.all([...connected(game), rejoined].map(
            (c) => c.waitFor((s) => s.activeNightRole === Role.SEER, 'seer turn everywhere'),
        ));

        const message = await emitExpectError(
            rejoined,
            'werewolfVote',
            { gameId: game.gameId, targetUUID: victim.playerUUID },
            'stale werewolf action after the turn advanced',
        );
        expect(message).toMatch(/not the turn of WEREWOLF/);
        expect(rejoined.state).toEqual(wolf.state);
        expect(rejoined.state!.players).toHaveLength(6);
        expect(rejoined.state!.role).toBe(wolf.state!.role);
        expectSamePublicView(connected(game), 'after rejoining mid-turn');
    });

    it('keeps the seat acting from the surviving socket when the primary closes on its own turn', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(NIGHT_ROLES);
        await Promise.all(connected(game).map((c) => c.waitForTurn(Role.WEREWOLF)));

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        expect(wolves).toHaveLength(2);
        const wolf = wolves[0]!;
        const otherWolf = wolves[1]!;
        const victim = game.clientsWithRole(Role.VILLAGER)[0]!;
        const uuid = wolf.playerUUID!;
        const tab = await openSocketFor(game, uuid);

        // The primary phone goes dark while the pack is deciding. The other socket of the
        // seat has to be promoted without the seat ever looking disconnected.
        wolf.close();
        await tab.waitFor((s) => s.playerUUID === uuid && s.activeNightRole === Role.WEREWOLF, 'tab holds the turn');

        tab.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: victim.playerUUID });
        otherWolf.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: victim.playerUUID });
        await Promise.all([...connected(game), tab].map(
            (c) => c.waitFor((s) => s.activeNightRole === Role.SEER, 'seer turn everywhere'),
        ));

        expect(tab.state!.role).toBe(Role.WEREWOLF);
        expect(tab.state!.players).toHaveLength(6);
        expectSamePublicView([...connected(game), tab], 'after acting from the survivor of a turn');
        game.expectNoErrors();
    });
});

describe('a rejoin storm on one seat', () => {
    it('binds every socket of the storm to the same seat without creating players', async () => {
        game = await TestGame.create({ playerCount: 6 });
        const phone = game.clients[2]!;
        const uuid = phone.playerUUID!;
        const seats = phone.state!.players.map((p) => p.playerUUID);

        // The production shape: one phone re-announcing itself from several sockets at once.
        const storm: Client[] = [];
        for (let i = 0; i < 4; i++) {
            const client = await Client.connect(game.server.url);
            extras.push(client);
            storm.push(client);
        }
        for (const client of storm) {
            client.socket.emit('joinGame', { gameId: game.gameId, playerUUID: uuid });
        }
        await Promise.all(storm.map((c) => c.waitFor((s) => s.playerUUID === uuid, 'storm socket bound')));

        const renames = [...connected(game), ...storm].map((c) => c.waitFor(
            (s) => s.players.some((p) => p.playerUUID === uuid && p.displayName === 'Storm survivor'),
            'storm sees the rename',
        ));
        storm[0]!.socket.emit('changeName', { gameId: game.gameId, playerName: 'Storm survivor' });
        await Promise.all(renames);

        expect(phone.state!.players.map((p) => p.playerUUID)).toEqual(seats);
        for (const client of storm) {
            expect(client.state!.players).toHaveLength(6);
            expect(client.state!.players.map((p) => p.playerUUID)).toEqual(seats);
        }
        expectSamePublicView([...connected(game), ...storm], 'after the rejoin storm');
        game.expectNoErrors();
    });
});

describe('a socket that announces another seat', () => {
    it('is a no-op for its own seat in the same game', async () => {
        game = await TestGame.create({ playerCount: 6 });
        const seatA = game.clients[1]!;
        const seatB = game.clients[2]!;
        await rename(game, seatA, 'Seat A');
        await rename(game, seatB, 'Seat B');
        const uuidA = seatA.playerUUID!;
        const seatsBefore = seatA.state!.players.map((p) => p.playerUUID);

        seatA.socket.emit('joinGame', { gameId: game.gameId, playerUUID: seatB.playerUUID });
        const answered = await waitForNewSnapshot(seatA, 'answer to the second seat announcement');

        expect(answered.playerUUID).toBe(uuidA);
        expect(answered.displayName).toBe('Seat A');
        expect(answered.players.map((p) => p.playerUUID)).toEqual(seatsBefore);
        expect(answered.players.filter((p) => p.playerUUID === uuidA)).toHaveLength(1);
        expect(seatA.errors).toHaveLength(0);

        // Re-announcing the *own* seat twice in a row stays idempotent too.
        seatA.socket.emit('joinGame', { gameId: game.gameId, playerUUID: uuidA });
        seatA.socket.emit('joinGame', { gameId: game.gameId, playerUUID: uuidA });
        const again = await waitForNewSnapshot(seatA, 'answer to the double own-seat announcement');
        expect(again.playerUUID).toBe(uuidA);
        expect(again.players).toHaveLength(6);

        await rename(game, seatA, 'Seat A again');
        await game.clients[3]!.waitFor(
            (s) => s.players.some((p) => p.displayName === 'Seat A again') && s.players.some((p) => p.displayName === 'Seat B'),
            'seat B kept its name',
        );
        expect(seatB.state!.displayName).toBe('Seat B');
        game.expectNoErrors();
    });
});

describe('one socket playing two games', () => {
    it('does not leak the old game’s snapshots into the socket that moved on', async () => {
        game = await TestGame.create({ playerCount: 4 });
        const phone = game.clients[2]!;
        const uuidA = phone.playerUUID!;
        const nameA = phone.state!.displayName;
        const { gameId: gameB, host } = await createSecondGame(game);
        expect(host.state!.gameId).toBe(gameB);

        phone.socket.emit('joinGame', { gameId: gameB, playerUUID: null });
        await phone.waitFor((s) => s.gameId === gameB && s.playerUUID !== null, 'phone joined the second game');
        const uuidB = phone.playerUUID!;
        expect(uuidB).not.toBe(uuidA);
        // A socket holds one seat at a time: the seat in A is released on the move.
        expect(storedSocketId(game.gameId, uuidA)).toBeNull();
        const mark = phone.history.length;

        // Game A moves on without the phone. The GM renaming themselves broadcasts to
        // every seat of A, including the seat this socket was registered on.
        const manager = game.manager;
        const managerUUID = manager.playerUUID!;
        const broadcast = connected(game)
            .filter((c) => c !== phone)
            .map((c) => c.waitFor((s) => s.players.find((p) => p.playerUUID === managerUUID)?.displayName === 'A moved on', 'game A broadcast'));
        manager.socket.emit('changeName', { gameId: game.gameId, playerName: 'A moved on' });
        await Promise.all(broadcast);

        // Round-trip in game B, on the same TCP connection, so any packet A wrote before
        // this point has certainly arrived by the time the B snapshot is delivered.
        phone.socket.emit('changeName', { gameId: gameB, playerName: 'B still mine' });
        await phone.waitFor((s) => s.gameId === gameB && s.displayName === 'B still mine', 'game B round-trip');

        const afterMove = phone.history.slice(mark);
        const leaked = afterMove.filter((s) => s.gameId !== gameB);
        expect(
            leaked.map((s) => `${s.gameId}:${s.playerUUID}`),
            `game A snapshots reached a socket that now plays game B (seat ${uuidA} / ${nameA})`,
        ).toEqual([]);
        expect(phone.state!.gameId).toBe(gameB);
        expect(phone.state!.playerUUID).toBe(uuidB);

        // The seat it left is not a back door: the socket cannot act in game A any more.
        const ghost = await emitExpectError(
            phone,
            'changeName',
            { gameId: game.gameId, playerName: 'ghost in A' },
            'action in the game the socket left',
        );
        expect(ghost).toMatch(/not found/i);
        expect(manager.state!.players.find((p) => p.playerUUID === uuidA)!.displayName).not.toBe('ghost in A');
    });

    it('lets the same socket come back to the game it left and act there again', async () => {
        game = await TestGame.create({ playerCount: 4 });
        await game.setupAndStart(ONE_WOLF);
        await Promise.all(connected(game).map((c) => c.waitForTurn(Role.WEREWOLF)));

        const wolf = only(game, Role.WEREWOLF);
        const uuidA = wolf.playerUUID!;
        const roleA = wolf.state!.role;
        const victim = game.aliveClients().find((c) => c !== wolf && c.playerUUID !== game.manager.playerUUID)!;
        const { gameId: gameB } = await createSecondGame(game);

        // A detour through a second game while the pack's turn is waiting.
        wolf.socket.emit('joinGame', { gameId: gameB, playerUUID: null });
        await wolf.waitFor((s) => s.gameId === gameB && s.playerUUID !== null, 'wolf is in game B');
        const uuidB = wolf.playerUUID!;
        expect(storedSocketId(game.gameId, uuidA)).toBeNull();

        wolf.socket.emit('joinGame', { gameId: game.gameId, playerUUID: uuidA });
        await wolf.waitFor((s) => s.gameId === game.gameId && s.playerUUID === uuidA, 'wolf is back in game A');

        expect(wolf.state!.phase).toBe(Phase.NIGHT);
        expect(wolf.state!.role).toBe(roleA);
        expect(wolf.state!.players).toHaveLength(4);
        expect(storedSocketId(game.gameId, uuidA)).toBe(wolf.socket.id);
        expect(storedSocketId(gameB, uuidB)).toBeNull();

        // Back in the seat and back in charge of its own turn: the kill still lands.
        wolf.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: victim.playerUUID });
        await game.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);
        for (const client of connected(game)) {
            expect(client.state!.players.find((p) => p.playerUUID === victim.playerUUID)!.isAlive).toBe(false);
        }
        game.expectNoErrors();
    });

    it('releases the seat it holds when it disconnects, without disturbing the game it left', async () => {
        game = await TestGame.create({ playerCount: 4 });
        const phone = game.clients[2]!;
        const uuidA = phone.playerUUID!;
        const { gameId: gameB } = await createSecondGame(game);

        phone.socket.emit('joinGame', { gameId: gameB, playerUUID: null });
        await phone.waitFor((s) => s.gameId === gameB && s.playerUUID !== null, 'phone joined the second game');
        const uuidB = phone.playerUUID!;

        phone.close();

        await expect
            .poll(() => storedSocketId(gameB, uuidB), { timeout: 3000 })
            .toBeNull();
        expect(storedSocketId(game!.gameId, uuidA)).toBeNull();

        // Game A is still a working game: the remaining seats act and see each other.
        const actor = connected(game)[1]!;
        const observer = connected(game).find((c) => c !== actor)!;
        const seen = observer.waitFor((s) => s.players.some((p) => p.playerUUID === actor.playerUUID && p.displayName === 'A carries on'), 'A still live');
        actor.socket.emit('changeName', { gameId: game!.gameId, playerName: 'A carries on' });
        await seen;
    });
});

describe('socket churn on one seat', () => {
    it('stays actionable until the last socket closes, then releases the seat for a rejoin', async () => {
        game = await TestGame.create({ playerCount: 6 });
        const phone = game.clients[3]!;
        const uuid = phone.playerUUID!;
        await rename(game, phone, 'Churner');
        // A broadcast to a socket that is already closed is a silent no-op; it must never
        // reach the "failed to sync/build state" fallbacks.
        const consoleError = vi.spyOn(console, 'error');

        const sockets = [phone];
        for (let i = 0; i < 4; i++) sockets.push(await openSocketFor(game, uuid));
        expect(sockets).toHaveLength(5);

        const order = [2, 0, 4, 1, 3];
        let round = 0;
        for (const index of order) {
            sockets[index]!.close();
            const survivors = sockets.filter((s) => s.socket.connected);
            if (survivors.length === 0) continue;

            round += 1;
            const name = `churn ${round}`;
            const waits = survivors.map((s) => s.waitFor((state) => state.displayName === name, `every survivor sees ${name}`));
            survivors[survivors.length - 1]!.socket.emit('changeName', { gameId: game.gameId, playerName: name });
            await Promise.all(waits);
            for (const survivor of survivors) {
                expect(survivor.state!.playerUUID).toBe(uuid);
                expect(survivor.state!.players).toHaveLength(6);
            }
        }

        await expect
            .poll(() => storedSocketId(game!.gameId, uuid), { timeout: 3000 })
            .toBeNull();

        const failedSyncs = consoleError.mock.calls
            .map((args) => args.map((arg) => String(arg)).join(' '))
            .filter((line) => /Failed to (sync|build) state/.test(line));
        expect(failedSyncs).toEqual([]);

        const back = await game.rejoinPlayer(uuid);
        extras.push(back);
        expect(back.state!.displayName).toBe(`churn ${round}`);
        expect(back.state!.players).toHaveLength(6);

        // The seat is a first-class player again, not a ghost.
        const phase = connected(game).map((c) => c.waitForPhase(Phase.ROLE_SELECTION));
        game.manager.socket.emit('closeJoining', { gameId: game.gameId });
        await Promise.all([...phase, back.waitForPhase(Phase.ROLE_SELECTION)]);
        expect(back.state!.players).toHaveLength(6);
        game.expectNoErrors();
    });

    it('ignores a disconnect from a socket that never joined, and from a game that was deleted', async () => {
        game = await TestGame.create({ playerCount: 4 });

        // A stranger connects and disappears without ever announcing a seat.
        const stranger = await Client.connect(game.server.url);
        extras.push(stranger);
        stranger.close();
        await rename(game, game.clients[1]!, 'still alive');

        // A real seat whose game disappears underneath it.
        const doomed = await Client.connect(game.server.url);
        extras.push(doomed);
        doomed.socket.emit('joinGame', { gameId: game.gameId, playerUUID: null });
        await doomed.waitFor((s) => s.playerUUID !== null, 'doomed player joined');
        GameStore.getInstance().deleteGame(game.gameId);

        const message = await emitExpectError(
            doomed,
            'changeName',
            { gameId: game.gameId, playerName: 'ghost' },
            'action in a game that no longer exists',
        );
        expect(message).toMatch(/not found/i);
        doomed.close();

        // The server is still healthy: a new socket gets a game again.
        const probe = await Client.connect(game.server.url);
        extras.push(probe);
        expect(probe.socket.connected).toBe(true);
    });
});

describe('rejoin in the awkward phases', () => {
    it('rebinds a dead player to the same seat and the same revealed role', async () => {
        game = await TestGame.create({ playerCount: 4 });
        await game.setupAndStart(ONE_WOLF);
        const victim = await killOneVillager(game);
        const uuid = victim.playerUUID!;
        const role = victim.state!.role!;
        const seats = game.manager.state!.players.map((p) => p.playerUUID);

        victim.close();
        const back = await game.rejoinPlayer(uuid);
        extras.push(back);

        expect(back.state!.playerUUID).toBe(uuid);
        expect(back.state!.role).toBe(role);
        expect(back.state!.phase).toBe(Phase.SHERIFF_ELECTION);
        expect(back.state!.players.map((p) => p.playerUUID)).toEqual(seats);

        // A dead player's role is public; the living players' roles stay hidden.
        for (const state of [back.state!, ...connected(game).map((c) => c.state!)]) {
            for (const entry of state.players) {
                if (entry.playerUUID === uuid) {
                    expect(entry.isAlive).toBe(false);
                    expect(entry.role).toBe(role);
                } else {
                    expect(entry.role).toBeNull();
                }
            }
        }

        await advanceToDay(game);
        await back.waitForPhase(Phase.DAY);
        expect(back.state!.role).toBe(role);
        game.expectNoErrors();
    });

    it('keeps the seat, role and winner of a finished game', async () => {
        game = await TestGame.create({ playerCount: 4 });
        await game.setupAndStart(ALL_WOLVES);
        const victim = only(game, Role.VILLAGER);
        const wolves = game.clientsWithRole(Role.WEREWOLF);
        for (const wolf of wolves) {
            wolf.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: victim.playerUUID });
        }
        await game.waitForPhaseEverywhere(Phase.GAME_OVER);

        const rolesBefore = new Map(game.clients.map((c) => [c.playerUUID!, c.state!.role!]));
        expect(game.manager.state!.winningTeam).toBe('werewolves');
        expect(game.manager.state!.players.every((p) => p.role !== null)).toBe(true);

        const victimUUID = victim.playerUUID!;
        const wolf = wolves[0]!;
        const wolfUUID = wolf.playerUUID!;
        victim.close();
        wolf.close();

        const deadBack = await game.rejoinPlayer(victimUUID);
        extras.push(deadBack);
        const wolfBack = await game.rejoinPlayer(wolfUUID);
        extras.push(wolfBack);

        for (const back of [deadBack, wolfBack]) {
            expect(back.state!.phase).toBe(Phase.GAME_OVER);
            expect(back.state!.winningTeam).toBe('werewolves');
            expect(back.state!.players).toHaveLength(4);
            expect(back.state!.players.every((p) => p.role !== null)).toBe(true);
        }
        expect(deadBack.state!.playerUUID).toBe(victimUUID);
        expect(deadBack.state!.role).toBe(rolesBefore.get(victimUUID));
        expect(deadBack.state!.players.find((p) => p.playerUUID === victimUUID)!.isAlive).toBe(false);
        expect(wolfBack.state!.playerUUID).toBe(wolfUUID);
        expect(wolfBack.state!.role).toBe(rolesBefore.get(wolfUUID));
        expect(wolfBack.state!.players.find((p) => p.playerUUID === wolfUUID)!.isAlive).toBe(true);
        expectSamePublicView(connected(game), 'after rejoining a finished game');
    });
});

describe('two sockets on the game master seat', () => {
    it('advances exactly one step per emit, from either socket', async () => {
        game = await TestGame.create({ playerCount: 4 });
        await game.setupAndStart(ONE_WOLF);
        const manager = game.manager;
        const second = await openSocketFor(game, manager.playerUUID!);
        expect(second.state!.isManager).toBe(true);

        // Night -> sheriff election. One step, so the election is still unresolved.
        const nightEnded = [manager, second].map((c) => c.waitFor((s) => s.phase === Phase.SHERIFF_ELECTION, 'night ended'));
        manager.socket.emit('managerAdvance', { gameId: game.gameId });
        await Promise.all(nightEnded);
        expect(manager.state!.phase).toBe(Phase.SHERIFF_ELECTION);
        expect(manager.state!.sheriffElectionDone).toBe(false);

        // Election resolved. One step, so the phase stays SHERIFF_ELECTION.
        const electionResolved = [manager, second].map((c) => c.waitFor((s) => s.sheriffElectionDone, 'election resolved'));
        second.socket.emit('managerAdvance', { gameId: game.gameId });
        await Promise.all(electionResolved);
        expect(manager.state!.phase).toBe(Phase.SHERIFF_ELECTION);

        // Badge accepted -> DAY.
        const dayStarted = [manager, second].map((c) => c.waitForPhase(Phase.DAY));
        second.socket.emit('managerAdvance', { gameId: game.gameId });
        await Promise.all(dayStarted);
        await game.waitForPhaseEverywhere(Phase.DAY);

        expect(manager.state).toEqual(second.state);
        expectSamePublicView(connected(game), 'after three GM advances');
        expect(manager.state!.players).toHaveLength(4);
    });
});

describe('secrets and public state across seats', () => {
    it('keeps every socket of a seat identical while the seats disagree only on secrets', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(NIGHT_ROLES);
        await Promise.all(connected(game).map((c) => c.waitForTurn(Role.WEREWOLF)));

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        expect(wolves).toHaveLength(2);
        const wolf = wolves[0]!;
        const otherWolf = wolves[1]!;
        const villager = game.clientsWithRole(Role.VILLAGER)[0]!;
        const victim = game.clientsWithRole(Role.VILLAGER)[1]!;
        const wolfUUID = wolf.playerUUID!;

        const wolfTab = await openSocketFor(game, wolfUUID);
        const villagerTab = await openSocketFor(game, villager.playerUUID!);

        const voteSeen = [wolf, wolfTab].map((c) => c.waitFor(
            (s) => s.werewolfVotes?.[wolfUUID] === victim.playerUUID,
            'wolf vote visible to the pack',
        ));
        // The other seats receive the same broadcast, without the pack's private view.
        const villagerSeen = [villager, villagerTab].map((c) => waitForNewSnapshot(c, 'villager view after the wolf vote'));
        wolf.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: victim.playerUUID });
        await Promise.all([...voteSeen, ...villagerSeen]);

        expect(wolfTab.state).toEqual(wolf.state);
        expect(villagerTab.state).toEqual(villager.state);
        expect(wolf.state!.werewolfVotes).toEqual({ [wolfUUID]: victim.playerUUID });
        expect(villager.state!.werewolfVotes).toBeNull();
        expect(villager.state!.werewolfVictim).toBeNull();
        expectSamePublicView(connected(game), 'after the first wolf vote');

        // Second wolf vote -> seer turn. The seer alone sees what they looked at.
        otherWolf.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: victim.playerUUID });
        await Promise.all([wolf, wolfTab].map((c) => c.waitForTurn(Role.SEER)));
        const seer = only(game, Role.SEER);
        const peek = game.aliveClients().find((c) => c !== seer)!;

        const seerSees = seer.waitFor((s) => s.seerRevealUUID === peek.playerUUID, 'seer sees the reveal');
        const villagerViews = [villager, villagerTab].map((c) => waitForNewSnapshot(c, 'villager view after the reveal'));
        seer.socket.emit('revealRole', { gameId: game.gameId, revealUUID: peek.playerUUID });
        await Promise.all([seerSees, ...villagerViews]);

        expect(villager.state!.seerRevealUUID).toBeNull();
        expect(villager.state!.seerRevealRole).toBeNull();
        expect(villagerTab.state).toEqual(villager.state);
        expectSamePublicView(connected(game), 'during the seer turn');
        game.expectNoErrors();
    });
});
