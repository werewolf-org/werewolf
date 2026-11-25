import { describe, it, expect, afterEach } from 'vitest';
import { Client, TestGame } from './harness.js';
import type { Snapshot } from './harness.js';
import { Phase } from '@shared/phases.js';
import { Role } from '@shared/roles.js';

// Reconnect / disconnect contract over real sockets. See BUGS.md WP3 (B15-B19).
//
// The harness mirrors the real frontend: it re-emits `joinGame` on every (re)connect,
// because socket.io hands out a new socket id after any blip. Every assertion here is
// made on a tailored snapshot, i.e. on what a player's phone would actually render.

// 6 players, a full night order of Werewolf -> Seer -> Witch and no Cupid, so a night
// can be played to the end without resolving a first-night-only role.
const NIGHT_ROLES: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.SEER]: 1,
    [Role.WITCH]: 1,
    [Role.VILLAGER]: 2,
};

let game: TestGame | null = null;

afterEach(async () => {
    await game?.close();
    game = null;
});

const connected = (g: TestGame): Client[] => g.clients.filter((c) => c.socket.connected);

const alive = (c: Client): boolean =>
    c.state?.players.find((p) => p.playerUUID === c.playerUUID)?.isAlive ?? false;

async function waitForTurnEverywhere(g: TestGame, role: string): Promise<void> {
    await Promise.all(connected(g).map((c) => c.waitForTurn(role)));
}

/** Waits for a snapshot that is newer than the one the client already holds. */
async function waitForNewSnapshot(client: Client, label: string): Promise<Snapshot> {
    const before = client.history.length;
    return client.waitFor(() => client.history.length > before, label);
}

/**
 * Emits `managerAdvance` and waits until the manager's own snapshot reaches `predicate`.
 * The waiter is registered before the emit so a fast reply cannot be missed.
 */
async function advanceManager(
    g: TestGame,
    predicate: (s: Snapshot) => boolean,
    label: string,
): Promise<Snapshot> {
    const waiter = g.manager.waitFor(predicate, label);
    g.manager.socket.emit('managerAdvance', { gameId: g.gameId });
    return waiter;
}

/**
 * Emits a deliberately rejected event and resolves with the server's error message.
 * The harness listener also records it in `client.errors` (registered first, so it is
 * already there when this promise resolves).
 */
async function emitExpectError(
    client: Client,
    event: string,
    payload: unknown,
    label: string,
): Promise<string> {
    const before = client.errors.length;
    const wait = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`Timed out after 2000ms waiting for an error after "${label}"`)),
            2000,
        );
        client.socket.once('error', (data: { message: string }) => {
            clearTimeout(timer);
            resolve(data.message);
        });
    });
    client.socket.emit(event, payload);
    const message = await wait;
    expect(client.errors.length).toBeGreaterThan(before);
    return message;
}

/** Plays night 0 (wolves kill a villager, seer peeks, witch does nothing) to dawn. */
async function playNightZero(g: TestGame): Promise<Client> {
    await waitForTurnEverywhere(g, Role.WEREWOLF);

    const wolves = g.clientsWithRole(Role.WEREWOLF);
    expect(wolves).toHaveLength(2);
    const victim = g.clientsWithRole(Role.VILLAGER)[0]!;
    for (const wolf of wolves) {
        wolf.socket.emit('werewolfVote', { gameId: g.gameId, targetUUID: victim.playerUUID });
    }

    await waitForTurnEverywhere(g, Role.SEER);
    const seer = g.clientsWithRole(Role.SEER)[0]!;
    const peek = connected(g).find((c) => c !== seer && alive(c))!;
    seer.socket.emit('revealRole', { gameId: g.gameId, revealUUID: peek.playerUUID });
    await seer.waitFor((s) => s.seerRevealUUID === peek.playerUUID, 'seer saw the role');
    seer.socket.emit('seerConfirmed', { gameId: g.gameId });

    await waitForTurnEverywhere(g, Role.WITCH);
    g.clientsWithRole(Role.WITCH)[0]!.socket.emit('witchConfirms', { gameId: g.gameId });

    await g.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);
    return victim;
}

/** Sheriff election (nobody nominated) -> DAY, using the GM escape hatch. */
async function advanceToDay(g: TestGame): Promise<void> {
    await advanceManager(
        g,
        (s) => s.phase === Phase.SHERIFF_ELECTION && s.sheriffElectionDone,
        'sheriff election resolved',
    );
    await advanceManager(g, (s) => s.phase === Phase.DAY, 'day phase');
    await Promise.all(connected(g).map((c) => c.waitForPhase(Phase.DAY)));
}

describe('reconnect: page reload mid-day', () => {
    it('rebinds the same seat and the reloaded client can still vote', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(NIGHT_ROLES);
        const victim = await playNightZero(game);
        await advanceToDay(game);

        // Sanity: the night really resolved a death.
        expect(victim.state!.phase).toBe(Phase.DAY);
        expect(alive(victim)).toBe(false);

        const seatOrder = game.manager.state!.players.map((p) => p.playerUUID);
        const reloadedPlayer = connected(game).find((c) => !c.state!.isManager && alive(c))!;
        const uuid = reloadedPlayer.playerUUID!;
        const roleBefore = reloadedPlayer.state!.role;
        const nameBefore = reloadedPlayer.state!.displayName;
        const socketBefore = reloadedPlayer.socket.id;

        // The tab goes away completely; the seat must survive on its own.
        reloadedPlayer.close();

        const reloaded = await game.rejoinPlayer(uuid);
        game.clients.push(reloaded);

        expect(reloaded.socket.id).toBeTruthy();
        expect(reloaded.socket.id).not.toBe(socketBefore);
        expect(reloaded.state!.playerUUID).toBe(uuid);
        expect(reloaded.state!.phase).toBe(Phase.DAY);
        expect(reloaded.state!.role).toBe(roleBefore);
        expect(reloaded.state!.displayName).toBe(nameBefore);
        expect(reloaded.state!.players).toHaveLength(6);
        expect(reloaded.state!.players.map((p) => p.playerUUID)).toEqual(seatOrder);
        expect(reloaded.state!.players.filter((p) => p.playerUUID === uuid)).toHaveLength(1);

        // The reloaded client is a first-class player again: it can vote in the same day.
        const voters = connected(game).filter(alive);
        const others = voters.filter((c) => c !== reloaded);
        expect(others.length).toBeGreaterThanOrEqual(2);
        const nominee = others[0]!;
        const nominator = others[1]!;

        nominator.socket.emit('nominate', { gameId: game.gameId, nominationUUID: nominee.playerUUID });
        for (const voter of voters) {
            if (voter === nominator) continue;
            voter.socket.emit('nominate', { gameId: game.gameId, nominationUUID: false });
        }
        await Promise.all(voters.map((c) => c.waitFor((s) => s.nominationsFinished, 'nominations finished')));

        reloaded.socket.emit('vote', { gameId: game.gameId, voteTargetUUID: nominee.playerUUID });
        await reloaded.waitFor(
            (s) => s.myVoteTargetUUID === nominee.playerUUID,
            'vote from the reloaded client accepted',
        );

        game.expectNoErrors();
    });
});

describe('reconnect: network blip', () => {
    it('keeps the seat and accepts an action after socket.io assigns a new socket id', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(NIGHT_ROLES);
        await waitForTurnEverywhere(game, Role.WEREWOLF);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const wolf = wolves[0]!;
        const otherWolf = wolves[1]!;
        const victim = game.clientsWithRole(Role.VILLAGER)[0]!;
        const socketBefore = wolf.socket.id;

        await wolf.dropAndReconnect();

        expect(wolf.socket.id).toBeTruthy();
        expect(wolf.socket.id).not.toBe(socketBefore);

        const afterReconnect = await waitForNewSnapshot(wolf, 'snapshot after the blip');
        expect(afterReconnect.playerUUID).toBe(wolf.playerUUID);
        expect(afterReconnect.phase).toBe(Phase.NIGHT);
        expect(afterReconnect.players).toHaveLength(6);

        // The action is accepted on the new socket, and its own snapshot confirms it.
        wolf.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: victim.playerUUID });
        await wolf.waitFor(
            (s) => s.werewolfVotes?.[wolf.playerUUID!] === victim.playerUUID,
            'wolf vote accepted after the blip',
        );

        otherWolf.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: victim.playerUUID });
        await waitForTurnEverywhere(game, Role.SEER);

        game.expectNoErrors();
    });
});

describe('reconnect: lobby refresh', () => {
    it('does not duplicate the player and leaves the GM badge in place', async () => {
        game = await TestGame.create({ playerCount: 6 });
        const oldManager = game.manager;
        const managerUUID = oldManager.playerUUID!;
        const seatsBefore = oldManager.state!.players.map((p) => p.playerUUID);

        // Refresh the manager's phone before the lobby is closed (the B17 case).
        const reloaded = await game.rejoinPlayer(managerUUID);
        expect(reloaded.state!.isManager).toBe(true);
        expect(reloaded.state!.playerUUID).toBe(managerUUID);
        expect(reloaded.state!.players).toHaveLength(6);
        expect(reloaded.state!.players.map((p) => p.playerUUID)).toEqual(seatsBefore);
        expect(reloaded.state!.players.filter((p) => p.playerUUID === managerUUID)).toHaveLength(1);

        oldManager.close();
        game.clients.push(reloaded);

        // The refreshed manager must still be able to run the lobby; a phantom duplicate
        // player would have stolen the badge and made closeJoining impossible.
        const waiters = connected(game).map((c) => c.waitForPhase(Phase.ROLE_SELECTION));
        reloaded.socket.emit('closeJoining', { gameId: game.gameId });
        await Promise.all(waiters);

        expect(reloaded.state!.isManager).toBe(true);
        expect(reloaded.state!.players).toHaveLength(6);
        for (const c of connected(game)) {
            expect(c.state!.players).toHaveLength(6);
        }
        game.expectNoErrors();
    });
});

describe('reconnect: after the lobby closed', () => {
    it('accepts a rejoin and rejects an unknown game / unknown UUID without crashing', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(NIGHT_ROLES);
        await waitForTurnEverywhere(game, Role.WEREWOLF);

        const player = game.clients[2]!;
        const uuid = player.playerUUID!;
        const role = player.state!.role;
        const seats = game.manager.state!.players.map((p) => p.playerUUID);

        player.close();
        const rejoined = await game.rejoinPlayer(uuid);
        game.clients.push(rejoined);

        expect(rejoined.state!.playerUUID).toBe(uuid);
        expect(rejoined.state!.role).toBe(role);
        expect(rejoined.state!.phase).toBe(Phase.NIGHT);
        expect(rejoined.state!.players.map((p) => p.playerUUID)).toEqual(seats);

        const intruder = await Client.connect(game.server.url);
        try {
            const bogusGameId = game.gameId === 'ZZZZ' ? 'YYYY' : 'ZZZZ';
            const unknownGameError = await emitExpectError(
                intruder,
                'joinGame',
                { gameId: bogusGameId, playerUUID: null },
                'join a game that does not exist',
            );
            expect(unknownGameError).toMatch(/not found/i);

            const unknownUuidError = await emitExpectError(
                intruder,
                'joinGame',
                { gameId: game.gameId, playerUUID: '11111111-1111-4111-8111-111111111111' },
                'join with a UUID that is not in the game',
            );
            expect(unknownUuidError).toMatch(/no longer accepting/i);

            // No snapshot was ever tailored for the impostor.
            expect(intruder.state).toBeNull();
            expect(intruder.playerUUID).toBeNull();
            expect(intruder.errors).toHaveLength(2);

            // The server is still alive and the real game still moves.
            for (const c of connected(game)) {
                expect(c.state!.players).toHaveLength(6);
                expect(c.state!.phase).toBe(Phase.NIGHT);
            }
            const beforeRole = game.manager.state!.activeNightRole;
            await advanceManager(
                game,
                (s) => s.phase !== Phase.NIGHT || s.activeNightRole !== beforeRole,
                'game still advances after the impostor attempts',
            );
        } finally {
            intruder.close();
        }

        game.expectNoErrors();
    });
});

describe('reconnect: disconnect mid-night', () => {
    it('still reaches a consistent dawn once the GM uses the escape hatch', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(NIGHT_ROLES);
        await waitForTurnEverywhere(game, Role.WEREWOLF);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        expect(wolves).toHaveLength(2);
        const victim = game.clientsWithRole(Role.VILLAGER)[0]!;
        const seer = game.clientsWithRole(Role.SEER)[0]!;
        const witch = game.clientsWithRole(Role.WITCH)[0]!;

        // The kill is fully ordered before the connection dies, so the dawn has a real death.
        for (const wolf of wolves) {
            wolf.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: victim.playerUUID });
        }
        await waitForTurnEverywhere(game, Role.SEER);

        // One of the two players who still have to act loses their connection. The GM must
        // never be that player, otherwise no advance would be possible at all.
        const blocker = game.manager === seer ? witch : seer;
        expect(blocker).not.toBe(game.manager);

        if (blocker === seer) {
            seer.close();
        } else {
            seer.socket.emit('revealRole', { gameId: game.gameId, revealUUID: victim.playerUUID });
            await seer.waitFor((s) => s.seerRevealUUID === victim.playerUUID, 'seer reveal');
            seer.socket.emit('seerConfirmed', { gameId: game.gameId });
            await waitForTurnEverywhere(game, Role.WITCH);
            witch.close();
        }

        // Stuck: the disconnected seat still counts, so nobody else can end the night.
        const survivor = connected(game)[0]!;
        expect(survivor.state!.phase).toBe(Phase.NIGHT);
        await expect(
            survivor.waitFor((s) => s.phase !== Phase.NIGHT, 'dawn without the GM', 500),
        ).rejects.toThrow(/Timed out/);

        let advances = 0;
        while (game.manager.state!.phase === Phase.NIGHT) {
            advances += 1;
            if (advances > 5) throw new Error('night did not end after five managerAdvance calls');
            const role = game.manager.state!.activeNightRole;
            await advanceManager(
                game,
                (s) => s.phase !== Phase.NIGHT || s.activeNightRole !== role,
                'escape hatch step',
            );
        }
        expect(advances).toBeGreaterThan(0);

        const survivors = connected(game);
        await Promise.all(survivors.map((c) => c.waitForPhase(Phase.SHERIFF_ELECTION)));

        // Dawn report: identical alive sets everywhere, the victim dead, the ghost seat kept.
        const aliveSets = survivors.map((c) =>
            c.state!.players
                .filter((p) => p.isAlive)
                .map((p) => p.playerUUID)
                .sort()
                .join(','),
        );
        expect(new Set(aliveSets).size).toBe(1);
        expect(survivors.length).toBe(5);
        for (const c of survivors) {
            expect(c.state!.players).toHaveLength(6);
            const victimEntry = c.state!.players.find((p) => p.playerUUID === victim.playerUUID)!;
            expect(victimEntry.isAlive).toBe(false);
        }

        game.expectNoErrors();
    });
});
