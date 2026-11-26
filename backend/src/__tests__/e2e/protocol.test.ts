import { describe, it, expect, afterEach } from 'vitest';
import { Client, TestGame } from './harness.js';
import type { Snapshot } from './harness.js';
import { Phase } from '@shared/phases.js';
import { Role } from '@shared/roles.js';
import { MAX_NAME_LENGTH } from '../../logic/handlers/lobby.handler.js';

// Protocol robustness, concurrency and isolation over the real socket contract.
//
// Everything here is sent with `client.socket.emit(...)` directly, because the harness only
// types the happy path. Three questions per event:
//   1. a malformed payload (null, {}, missing field, wrong type) must never crash the process
//      and must never advance the phase or corrupt a seat,
//   2. the game must still be playable afterwards (a real action is performed as the proof),
//   3. duplicate / concurrent sends must resolve exactly once and leave every client agreeing.
//
// Authorization (manager-only, out-of-turn, dead players, target validation) and
// reconnect/rejoin are already covered by security.test.ts and reconnect.test.ts.
//
// NOTE: one test here, "ignores a second joinGame from the same socket", is RED on purpose.
// It encodes the documented contract (one socket = one seat) and currently exposes a real
// server bug: a second `joinGame` with `playerUUID: null` creates a second player that shares
// the socket id. See the assertion message for the exact sequence. Do not weaken it.

const FULL_ROLES: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.SEER]: 1,
    [Role.WITCH]: 1,
    [Role.CUPID]: 1,
    [Role.VILLAGER]: 1,
};

// 6 players: a night order of Werewolf -> Seer, no Cupid and no Witch.
const LYNCH_ROLES: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.SEER]: 1,
    [Role.VILLAGER]: 3,
};

const DEFAULT_TIMEOUT = 5000;

let game: TestGame | null = null;
const extraClients: Client[] = [];

afterEach(async () => {
    extraClients.forEach((c) => c.close());
    extraClients.length = 0;
    await game?.close();
    game = null;
});

// --- local helpers (the harness is shared and must not be edited) ---

const connected = (g: TestGame): Client[] => g.clients.filter((c) => c.socket.connected);

const isAlive = (c: Client): boolean =>
    c.state?.players.find((p) => p.playerUUID === c.playerUUID)?.isAlive ?? false;

const aliveClients = (g: TestGame): Client[] => connected(g).filter(isAlive);

const deadUUIDs = (state: Snapshot): string[] =>
    state.players.filter((p) => !p.isAlive).map((p) => p.playerUUID);

async function waitForAll(g: TestGame, predicate: (s: Snapshot) => boolean, label: string): Promise<void> {
    await Promise.all(connected(g).map((c) => c.waitFor(predicate, label)));
}

/**
 * Emits a deliberately rejected payload and resolves with the server's error message.
 * The harness listener records the message in `client.errors` before ours runs (it was
 * registered first), so the count is already updated when this resolves.
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
        client.socket.once('error', ({ message }: { message: string }) => {
            clearTimeout(timer);
            resolve(message);
        });
    });
    client.socket.emit(event, payload as any);
    const message = await wait;
    expect(client.errors.length, label).toBeGreaterThan(before);
    return message;
}

/** The GM escape hatch, with the waiter registered before the emit. */
async function advance(
    g: TestGame,
    predicate: (s: Snapshot) => boolean,
    label: string,
): Promise<Snapshot> {
    const waiter = g.manager.waitFor(predicate, label);
    g.manager.socket.emit('managerAdvance', { gameId: g.gameId });
    return waiter;
}

/** One GM step through the current night sub-turn. */
async function advanceNightTurn(g: TestGame): Promise<void> {
    const turn = g.manager.state!.activeNightRole;
    await advance(
        g,
        (s) => s.phase !== Phase.NIGHT || s.activeNightRole !== turn,
        `night step from ${turn}`,
    );
}

/** Walks the night with the GM escape hatch until dawn; no night action is ever taken. */
async function advanceNightToDawn(g: TestGame): Promise<void> {
    let guard = 0;
    while (g.manager.state!.phase === Phase.NIGHT) {
        guard += 1;
        if (guard > 12) throw new Error('night did not reach dawn after twelve managerAdvance calls');
        await advanceNightTurn(g);
    }
    const phase = g.manager.state!.phase;
    await waitForAll(g, (s) => s.phase === phase, `phase ${phase} everywhere`);
}

/** Night 0 with no actions -> sheriff election -> day. */
async function walkToDay(g: TestGame): Promise<void> {
    await advanceNightToDawn(g);
    const manager = g.manager;
    if (manager.state!.phase === Phase.SHERIFF_ELECTION) {
        if (!manager.state!.sheriffElectionDone) {
            await advance(g, (s) => s.sheriffElectionDone, 'sheriff election resolved');
        }
        await advance(g, (s) => s.phase === Phase.DAY, 'day starts');
    }
    await waitForAll(g, (s) => s.phase === Phase.DAY, 'day everywhere');
}

/** Every living client nominates the same target (or explicitly abstains). */
async function nominateEveryone(g: TestGame, nominator: Client, targetUUID: string | false): Promise<void> {
    const voters = aliveClients(g);
    nominator.socket.emit('nominate', { gameId: g.gameId, nominationUUID: targetUUID });
    for (const c of voters) {
        if (c === nominator) continue;
        c.socket.emit('nominate', { gameId: g.gameId, nominationUUID: false });
    }
    await Promise.all(voters.map((c) => c.waitFor((s) => s.nominationsFinished, 'nominations finished')));
}

/** Emits every vote in the same tick and waits for the lynch to resolve. */
async function voteEveryone(g: TestGame, votes: Map<Client, string | false>): Promise<void> {
    await Promise.all(
        [...votes].map(([client, target]) => {
            const waiter = client.waitFor((s) => s.lynchDone, 'lynch resolved');
            client.socket.emit('vote', { gameId: g.gameId, voteTargetUUID: target });
            return waiter;
        }),
    );
}

/** Creates a second game on the same server (TestGame always clears the store, so no second TestGame). */
async function createExtraGame(url: string, playerCount: number): Promise<{ gameId: string; clients: Client[] }> {
    const host = await Client.connect(url);
    extraClients.push(host);

    const created = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('second game was not created')), DEFAULT_TIMEOUT);
        host.socket.once('gameCreated', ({ gameId }: { gameId: string }) => {
            clearTimeout(timer);
            resolve(gameId);
        });
    });
    host.socket.emit('createGame');
    const gameId = await created;
    host.gameId = gameId;

    const clients = [host];
    for (let i = 1; i < playerCount; i++) {
        const client = await Client.connect(url);
        extraClients.push(client);
        clients.push(client);
    }
    for (const client of clients) {
        client.gameId = gameId;
        client.socket.emit('joinGame', { gameId, playerUUID: null });
        await client.waitFor(() => client.playerUUID !== null, 'joined the second game');
    }
    await Promise.all(clients.map((c) => c.waitFor((s) => s.players.length === playerCount, 'second lobby full')));
    return { gameId, clients };
}

async function connectExtra(url: string): Promise<Client> {
    const client = await Client.connect(url);
    extraClients.push(client);
    return client;
}

// --- malformed payloads ---

describe('protocol: malformed payloads', () => {
    it('lobby events reject null, {}, missing fields and wrong types, then the lobby still works', async () => {
        game = await TestGame.create({ playerCount: 6 });
        const manager = game.manager;

        const cases: [string, unknown, string][] = [
            ['joinGame', null, 'joinGame null'],
            ['joinGame', {}, 'joinGame {}'],
            ['joinGame', { gameId: 42 }, 'joinGame numeric gameId'],
            ['joinGame', 'not-an-object', 'joinGame string'],
            ['changeName', null, 'changeName null'],
            ['changeName', {}, 'changeName {}'],
            ['changeName', { gameId: 42, playerName: 'x' }, 'changeName numeric gameId'],
            ['closeJoining', null, 'closeJoining null'],
            ['closeJoining', {}, 'closeJoining {}'],
            ['roleDistribution', null, 'roleDistribution null'],
            ['roleDistribution', {}, 'roleDistribution {}'],
            ['startGame', null, 'startGame null'],
            ['startGame', {}, 'startGame {}'],
            ['managerAdvance', null, 'managerAdvance null'],
            ['managerAdvance', {}, 'managerAdvance {}'],
        ];

        for (const [event, payload, label] of cases) {
            await emitExpectError(manager, event, payload, label);
        }
        // One error event per rejected emit, no silent extra mutations.
        expect(manager.errors).toHaveLength(cases.length);

        for (const c of connected(game)) {
            expect(c.state!.phase).toBe(Phase.LOBBY);
            expect(c.state!.players).toHaveLength(6);
            expect(c.state!.players.every((p) => p.role === null)).toBe(true);
            expect(c.state!.players.every((p) => p.isAlive)).toBe(true);
        }

        // Playable: a valid closeJoining with an unknown extra field is accepted and ignored.
        manager.socket.emit('closeJoining', { gameId: game.gameId, totallyUnknown: { nested: true } });
        await waitForAll(game, (s) => s.phase === Phase.ROLE_SELECTION, 'lobby closes after the malformed batch');
        expect(manager.errors).toHaveLength(cases.length);
    });

    it('roleDistribution rejects every malformed composition and leaves the roles unassigned', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.closeJoining();
        const manager = game.manager;

        const cases: [unknown, string][] = [
            [null, 'roles null'],
            [{}, 'roles missing'],
            [[], 'roles as array'],
            [{ [Role.WEREWOLF]: '2', [Role.VILLAGER]: 4 }, 'role amount as string'],
            [{ FOO: 6 }, 'unknown role key'],
            [{ [Role.WEREWOLF]: -1, [Role.VILLAGER]: 7 }, 'negative amount'],
            [{ [Role.WEREWOLF]: 2.5, [Role.VILLAGER]: 3.5 }, 'fractional amount'],
            [{ [Role.WEREWOLF]: 2, [Role.VILLAGER]: 3 }, 'sum too small'],
            [{ [Role.VILLAGER]: 6 }, 'no werewolf'],
        ];

        for (const [roles, label] of cases) {
            const message = await emitExpectError(
                manager,
                'roleDistribution',
                { gameId: game.gameId, roles },
                label,
            );
            expect(message, label).not.toBe('');
            for (const c of connected(game)) {
                expect(c.state!.phase, label).toBe(Phase.ROLE_SELECTION);
                expect(c.state!.role, label).toBeNull();
            }
        }
        expect(manager.errors).toHaveLength(cases.length);

        // Playable: the real composition, with an unknown top-level field, deals exactly once.
        manager.socket.emit('roleDistribution', { gameId: game.gameId, roles: LYNCH_ROLES, evil: 1 });
        await waitForAll(game, (s) => s.phase === Phase.DISTRIBUTION, 'roles distributed');
        expect(connected(game).filter((c) => c.state!.role === Role.WEREWOLF)).toHaveLength(2);
        expect(connected(game).filter((c) => c.state!.role === Role.SEER)).toHaveLength(1);
        expect(connected(game).filter((c) => c.state!.role === Role.VILLAGER)).toHaveLength(3);
        expect(manager.errors).toHaveLength(cases.length);
    });

    it('bindLovers rejects malformed payloads and a second bind, then a real bind advances', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(FULL_ROLES);
        await waitForAll(game, (s) => s.phase === Phase.NIGHT && s.activeNightRole === Role.CUPID, 'cupid turn');

        const cupid = game.clientsWithRole(Role.CUPID)[0]!;
        const nonCupids = connected(game).filter((c) => c !== cupid);
        const targets = nonCupids.slice(0, 2);

        const cases: [unknown, string][] = [
            [null, 'bindLovers null'],
            [{}, 'bindLovers {}'],
            [{ gameId: game.gameId }, 'both lovers missing'],
            [{ gameId: game.gameId, firstPlayerUUID: {}, secondPlayerUUID: {} }, 'lover targets as objects'],
            [{ gameId: game.gameId, firstPlayerUUID: 'x', secondPlayerUUID: 'y' }, 'lover targets unknown'],
            [
                { gameId: game.gameId, firstPlayerUUID: targets[0]!.playerUUID, secondPlayerUUID: targets[0]!.playerUUID },
                'same player twice',
            ],
        ];
        for (const [payload, label] of cases) {
            await emitExpectError(cupid, 'bindLovers', payload, label);
        }
        expect(cupid.errors).toHaveLength(cases.length);
        expect(cupid.state!.activeNightRole).toBe(Role.CUPID);
        expect(cupid.state!.cupidSelectedLovers).toBe(false);
        expect(cupid.state!.cupidFirstLoverUUID).toBeNull();
        expect(cupid.state!.cupidSecondLoverUUID).toBeNull();
        expect(targets.every((c) => c.state!.lovePartnerUUID === null)).toBe(true);

        // Playable: a real bond, then an immediate re-bind is a clean rejection.
        cupid.socket.emit('bindLovers', {
            gameId: game.gameId,
            firstPlayerUUID: targets[0]!.playerUUID,
            secondPlayerUUID: targets[1]!.playerUUID,
        });
        await cupid.waitFor((s) => s.cupidFirstLoverUUID === targets[0]!.playerUUID, 'cupid bound the lovers');
        await emitExpectError(
            cupid,
            'bindLovers',
            { gameId: game.gameId, firstPlayerUUID: targets[1]!.playerUUID, secondPlayerUUID: targets[0]!.playerUUID },
            're-bind in the same night',
        );
        expect(cupid.state!.cupidFirstLoverUUID).toBe(targets[0]!.playerUUID);
        expect(cupid.state!.cupidSecondLoverUUID).toBe(targets[1]!.playerUUID);
        expect(targets[0]!.state!.lovePartnerUUID).toBe(targets[1]!.playerUUID);
        expect(targets[1]!.state!.lovePartnerUUID).toBe(targets[0]!.playerUUID);

        for (const lover of targets) {
            lover.socket.emit('confirmLoverBond', { gameId: game.gameId });
        }
        await waitForAll(
            game,
            (s) => s.phase === Phase.NIGHT && s.activeNightRole === Role.WEREWOLF,
            'wolves after the lover bond',
        );
    });

    it('werewolfVote rejects malformed targets and the sub-turn does not advance', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(LYNCH_ROLES);
        await waitForAll(game, (s) => s.phase === Phase.NIGHT && s.activeNightRole === Role.WEREWOLF, 'wolf turn');

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const wolf = wolves[0]!;
        const otherWolf = wolves[1]!;
        const victim = game.clientsWithRole(Role.VILLAGER)[0]!;

        const cases: [unknown, string][] = [
            [null, 'werewolfVote null'],
            [{}, 'werewolfVote {}'],
            [{ gameId: game.gameId, targetUUID: {} }, 'target as object'],
            [{ gameId: game.gameId, targetUUID: 42 }, 'target as number'],
            [{ gameId: game.gameId, targetUUID: '' }, 'target empty string'],
            [{ gameId: game.gameId, targetUUID: wolf.playerUUID }, 'wolf votes for itself'],
        ];
        for (const [payload, label] of cases) {
            await emitExpectError(wolf, 'werewolfVote', payload, label);
            expect(wolf.state!.activeNightRole, label).toBe(Role.WEREWOLF);
            expect(wolf.state!.werewolfVotes, label).toBeNull();
        }
        expect(wolf.errors).toHaveLength(cases.length);
        expect(victim.state!.players.every((p) => p.isAlive)).toBe(true);

        // Playable: one vote carries an unknown field, the other is plain; exactly one advance.
        wolf.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: victim.playerUUID, evil: true });
        const advanceWaiter = otherWolf.waitFor(
            (s) => s.activeNightRole !== Role.WEREWOLF || s.phase !== Phase.NIGHT,
            'wolves resolve',
        );
        otherWolf.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: victim.playerUUID });
        await advanceWaiter;

        await waitForAll(game, (s) => s.activeNightRole === Role.SEER, 'seer turn everywhere');
        for (const w of wolves) {
            expect(w.state!.werewolfVotes).toEqual({
                [wolf.playerUUID!]: victim.playerUUID,
                [otherWolf.playerUUID!]: victim.playerUUID,
            });
            expect(w.state!.werewolfVictim).toBe(victim.playerUUID);
            expect(w.errors).toHaveLength(w === wolf ? cases.length : 0);
        }
        // Deaths are resolved at dawn, not when the vote is cast.
        expect(victim.state!.players.every((p) => p.isAlive)).toBe(true);
    });

    it('usePotion rejects malformed payloads without burning a potion', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(FULL_ROLES);
        await waitForAll(game, (s) => s.activeNightRole === Role.CUPID, 'cupid turn');

        // Cupid -> wolves -> seer -> witch, all with the GM escape hatch except the wolf kill.
        await advanceNightTurn(game); // cupid -> werewolf
        await waitForAll(game, (s) => s.activeNightRole === Role.WEREWOLF, 'wolf turn');
        const victim = game.clientsWithRole(Role.VILLAGER)[0]!;
        for (const wolf of game.clientsWithRole(Role.WEREWOLF)) {
            wolf.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: victim.playerUUID });
        }
        await waitForAll(game, (s) => s.activeNightRole === Role.SEER, 'seer turn');
        game.clientsWithRole(Role.SEER)[0]!.socket.emit('seerConfirmed', { gameId: game.gameId });
        await waitForAll(game, (s) => s.activeNightRole === Role.WITCH, 'witch turn');

        const witch = game.clientsWithRole(Role.WITCH)[0]!;
        expect(witch.state!.werewolfVictim).toBe(victim.playerUUID);

        const cases: [unknown, string][] = [
            [null, 'usePotion null payload'],
            [42, 'usePotion numeric payload'],
            [{}, 'usePotion {}'],
            [{ gameId: game.gameId }, 'no potion requested'],
            [{ gameId: game.gameId, heal: null, killUUID: null }, 'null heal and null kill'],
            [{ gameId: game.gameId, heal: false }, 'heal false without a kill'],
            [{ gameId: game.gameId, heal: 'yes' }, 'heal as string'],
            [{ gameId: game.gameId, heal: 1 }, 'heal as number'],
            [{ gameId: game.gameId, heal: [], killUUID: null }, 'heal as array'],
            [{ gameId: game.gameId, heal: false, killUUID: {} }, 'kill target as object'],
            [{ gameId: game.gameId, heal: false, killUUID: 42 }, 'kill target as number'],
            [{ gameId: game.gameId, heal: false, killUUID: 'not-a-player' }, 'kill target unknown'],
            [{ gameId: game.gameId, heal: false, killUUID: witch.playerUUID }, 'witch poisons itself'],
        ];
        for (const [payload, label] of cases) {
            await emitExpectError(witch, 'usePotion', payload, label);
            expect(witch.state!.activeNightRole, label).toBe(Role.WITCH);
            expect(witch.state!.witchUsedHealingPotion, label).toBe(false);
            expect(witch.state!.witchUsedKillingPotion, label).toBe(false);
        }
        expect(witch.errors).toHaveLength(cases.length);

        // Wrong types are rejected before anything is written: "yes" must not burn the potion.
        const typeError = await emitExpectError(
            witch,
            'usePotion',
            { gameId: game.gameId, heal: 'yes' },
            'heal "yes" is not a boolean',
        );
        expect(typeError).toMatch(/boolean/i);
        expect(witch.state!.witchUsedHealingPotion).toBe(false);

        // Playable: a real boolean heal consumes exactly one potion and saves the victim.
        witch.socket.emit('usePotion', { gameId: game.gameId, heal: true });
        await witch.waitFor((s) => s.witchUsedHealingPotion, 'healing potion recorded');
        await emitExpectError(
            witch,
            'usePotion',
            { gameId: game.gameId, heal: true },
            'second healing potion',
        );
        expect(witch.state!.witchUsedKillingPotion).toBe(false);

        witch.socket.emit('witchConfirms', { gameId: game.gameId });
        await waitForAll(game, (s) => s.phase !== Phase.NIGHT, 'night ends after the witch confirms');
        // The only wolf target was healed and no poison was used.
        expect(deadUUIDs(witch.state!)).toEqual([]);
    });

    it('rejects wrong-typed nomination and vote targets while missing/null/false stay abstains', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(LYNCH_ROLES);
        await walkToDay(game);

        const victim = game.clientsWithRole(Role.SEER)[0]!;
        const others = aliveClients(game).filter((c) => c !== victim);
        const [prober, nominatingAbstainer, nominator, voterA, voterB] = others as [
            Client, Client, Client, Client, Client,
        ];

        // --- nominations ---
        // A non-object payload is rejected centrally, before the handler runs.
        const payloadMessage = await emitExpectError(prober, 'nominate', null, 'nominate null payload');
        expect(payloadMessage).toMatch(/Malformed event payload/);
        await emitExpectError(prober, 'nominate', 'not-an-object', 'nominate string payload');

        // A wrong-typed target is a hard error and must NOT consume the nomination.
        for (const [target, label] of [
            [42, 'number'],
            [{}, 'object'],
            [[], 'array'],
        ] as [unknown, string][]) {
            const message = await emitExpectError(
                prober,
                'nominate',
                { gameId: game.gameId, nominationUUID: target },
                `nominate ${label} target`,
            );
            expect(message, label).toMatch(/Invalid vote target/i);
            expect(prober.state!.myNominationUUID, `nominate ${label} must not be consumed`).toBeNull();
        }

        // Missing field / explicit null / explicit false are the documented abstain path.
        nominatingAbstainer.socket.emit('nominate', { gameId: game.gameId });
        await nominatingAbstainer.waitFor((s) => s.myNominationUUID === false, 'missing nomination is an abstain');
        await emitExpectError(
            nominatingAbstainer,
            'nominate',
            { gameId: game.gameId, nominationUUID: victim.playerUUID },
            'second nomination from the abstainer',
        );

        nominator.socket.emit('nominate', { gameId: game.gameId, nominationUUID: victim.playerUUID });
        prober.socket.emit('nominate', { gameId: game.gameId, nominationUUID: false });
        voterA.socket.emit('nominate', { gameId: game.gameId, nominationUUID: null });
        for (const c of [voterB, victim]) {
            c.socket.emit('nominate', { gameId: game.gameId, nominationUUID: false });
        }
        const alive = aliveClients(game);
        await Promise.all(alive.map((c) => c.waitFor((s) => s.nominationsFinished, 'nominations finished')));
        expect(alive).toHaveLength(6);

        // --- votes ---
        await emitExpectError(prober, 'vote', null, 'vote null payload');
        for (const [target, label] of [
            [42, 'number'],
            [{}, 'object'],
            [[], 'array'],
        ] as [unknown, string][]) {
            const message = await emitExpectError(
                prober,
                'vote',
                { gameId: game.gameId, voteTargetUUID: target },
                `vote ${label} target`,
            );
            expect(message, label).toMatch(/Invalid vote target/i);
            expect(prober.state!.myVoteTargetUUID, `vote ${label} must not be consumed`).toBeNull();
        }

        nominatingAbstainer.socket.emit('vote', { gameId: game.gameId });
        await nominatingAbstainer.waitFor((s) => s.myVoteTargetUUID === false, 'missing vote is an abstain');
        await emitExpectError(
            nominatingAbstainer,
            'vote',
            { gameId: game.gameId, voteTargetUUID: victim.playerUUID },
            'second vote from the abstainer',
        );

        // 4 votes for the victim, 2 explicit abstains (the victim is among them).
        await voteEveryone(
            game,
            new Map<Client, string | false>([
                [nominator, victim.playerUUID!],
                [voterA, victim.playerUUID!],
                [voterB, victim.playerUUID!],
                [prober, victim.playerUUID!],
                [victim, false],
            ]),
        );
        await waitForAll(
            game,
            (s) => s.lynchDone && s.votedOutUUID === victim.playerUUID,
            'lynch resolved exactly once',
        );

        const manager = game.manager;
        expect(manager.state!.votedOutUUID).toBe(victim.playerUUID);
        expect(deadUUIDs(manager.state!)).toEqual([victim.playerUUID!]);
        expect(manager.state!.voteResults).not.toBeNull();
        expect(Object.keys(manager.state!.voteResults!)).toHaveLength(6);
        // 2 central/typed nominate errors + 3 typed nominate targets + 1 central vote error + 3 typed vote targets.
        expect(prober.errors).toHaveLength(9);
        expect(nominatingAbstainer.errors).toHaveLength(2);
        for (const c of [nominator, voterA, voterB]) {
            expect(c.errors).toHaveLength(0);
        }
        // Playable: the game moves on to the next night.
        await advance(game, (s) => s.phase === Phase.NIGHT, 'night after the lynch');
    });

    it('acceptSheriffRole rejects malformed payloads, then accepts exactly once', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(LYNCH_ROLES);
        await advanceNightToDawn(game);

        expect(game.manager.state!.phase).toBe(Phase.SHERIFF_ELECTION);
        const manager = game.manager;

        await emitExpectError(manager, 'acceptSheriffRole', null, 'acceptSheriffRole null');
        await emitExpectError(manager, 'acceptSheriffRole', {}, 'acceptSheriffRole {}');
        expect(manager.state!.phase).toBe(Phase.SHERIFF_ELECTION);
        expect(manager.state!.sheriffElectionDone).toBe(false);

        // Resolve the (empty) election, then accept once and reject the replay.
        await advance(game, (s) => s.sheriffElectionDone, 'empty sheriff election resolved');
        expect(manager.state!.phase).toBe(Phase.SHERIFF_ELECTION);

        manager.socket.emit('acceptSheriffRole', { gameId: game.gameId });
        await waitForAll(game, (s) => s.phase === Phase.DAY, 'day after accepting');
        const errorsBeforeReplay = manager.errors.length;
        await emitExpectError(
            manager,
            'acceptSheriffRole',
            { gameId: game.gameId },
            'acceptSheriffRole twice',
        );
        expect(manager.errors.length).toBe(errorsBeforeReplay + 1);
        expect(manager.state!.phase).toBe(Phase.DAY);
        // No sheriff was elected (nobody nominated), so nobody wears the badge.
        expect(manager.state!.players.every((p) => !p.isSheriff)).toBe(true);
    });
});

// --- unknown events ---

describe('protocol: unknown events', () => {
    it('ignores prototype-shaped and random event names without an error or a state change', async () => {
        game = await TestGame.create({ playerCount: 6 });
        const manager = game.manager;
        const events = ['someRandomEvent', 'constructor', '__proto__', 'toString', 'hasOwnProperty'];

        for (const event of events) {
            manager.socket.emit(event, { gameId: game.gameId, playerName: 'hacked', roles: LYNCH_ROLES });
        }

        // The event queue is FIFO per socket, so a normal action that produces a snapshot proves
        // every unknown event before it was processed without killing the connection.
        manager.socket.emit('closeJoining', { gameId: game.gameId });
        await waitForAll(game, (s) => s.phase === Phase.ROLE_SELECTION, 'lobby still closes');

        expect(manager.errors).toHaveLength(0);
        expect(manager.state!.players).toHaveLength(6);
        expect(manager.state!.players.every((p) => p.role === null)).toBe(true);
        expect(manager.state!.displayName).not.toBe('hacked');
    });
});

// --- replays and duplicate actions ---

describe('protocol: replays and duplicate actions', () => {
    it('startGame twice does not restart the night or move the active role', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.closeJoining();
        await game.distributeRoles(LYNCH_ROLES);
        await game.startGame();

        const manager = game.manager;
        const turn = manager.state!.activeNightRole;
        const roles = game.clients.map((c) => c.state!.role);
        expect(turn).not.toBeNull();

        const message = await emitExpectError(manager, 'startGame', { gameId: game.gameId }, 'startGame twice');
        expect(message).toMatch(/phase/i);
        for (const c of connected(game)) {
            expect(c.state!.phase).toBe(Phase.NIGHT);
            expect(c.state!.activeNightRole).toBe(turn);
            expect(c.state!.players.every((p) => p.isAlive)).toBe(true);
        }
        expect(game.clients.map((c) => c.state!.role)).toEqual(roles);

        // Playable: exactly one GM step moves the turn.
        await advanceNightTurn(game);
        expect(manager.state!.activeNightRole).not.toBe(turn);
    });

    it('roleDistribution twice is rejected and the dealt roles stay untouched', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.closeJoining();
        await game.distributeRoles(LYNCH_ROLES);

        const rolesBefore = game.clients.map((c) => [c.playerUUID, c.state!.role] as const);
        const message = await emitExpectError(
            game.manager,
            'roleDistribution',
            { gameId: game.gameId, roles: FULL_ROLES },
            'roleDistribution twice',
        );
        expect(message).toMatch(/ROLE_SELECTION|phase/i);

        expect(game.clients.map((c) => [c.playerUUID, c.state!.role] as const)).toEqual(rolesBefore);
        for (const c of connected(game)) {
            expect(c.state!.phase).toBe(Phase.DISTRIBUTION);
        }
        expect(game.clients.filter((c) => c.state!.role === Role.CUPID)).toHaveLength(0);

        // Playable: the game still starts with the original deal.
        await game.startGame();
        expect(game.clients.filter((c) => c.state!.role === Role.WEREWOLF)).toHaveLength(2);
    });

    it('readyForNight is idempotent before the last player and a hard error after the night starts', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(LYNCH_ROLES);
        await walkToDay(game);

        const manager = game.manager;
        const voters = aliveClients(game);
        const first = voters[0]!;
        const last = voters[voters.length - 1]!;
        const middle = voters.slice(1, -1);

        // Before the lynch is resolved, readying is rejected (B12 regression guard).
        const beforeLynch = await emitExpectError(
            first,
            'readyForNight',
            { gameId: game.gameId },
            'readyForNight before the lynch',
        );
        expect(beforeLynch).toMatch(/lynch/i);
        expect(first.state!.phase).toBe(Phase.DAY);
        expect(first.state!.readyForNight).toBe(false);

        await advance(game, (s) => s.lynchDone, 'empty lynch resolved');
        expect(manager.state!.lynchDone).toBe(true);

        first.socket.emit('readyForNight', { gameId: game.gameId });
        await first.waitFor((s) => s.readyForNight, 'first player ready');
        const errorsBeforeDuplicate = first.errors.length;
        await first.emitWithWait('readyForNight', { gameId: game.gameId }, 'duplicate readyForNight');
        expect(first.errors.length).toBe(errorsBeforeDuplicate);
        expect(first.state!.phase).toBe(Phase.DAY);
        expect(first.state!.readyForNight).toBe(true);

        for (const c of middle) {
            c.socket.emit('readyForNight', { gameId: game.gameId });
        }
        await Promise.all(middle.map((c) => c.waitFor((s) => s.readyForNight, 'middle player ready')));
        expect(last.state!.phase).toBe(Phase.DAY);

        last.socket.emit('readyForNight', { gameId: game.gameId });
        await waitForAll(game, (s) => s.phase === Phase.NIGHT, 'night after every ready');
        const nightTurn = manager.state!.activeNightRole;

        const afterNight = await emitExpectError(
            last,
            'readyForNight',
            { gameId: game.gameId },
            'readyForNight during the night',
        );
        expect(afterNight).toMatch(/Day Phase/i);
        expect(last.state!.phase).toBe(Phase.NIGHT);
        expect(last.state!.activeNightRole).toBe(nightTurn);
    });

    it('createGame twice on one socket creates two independent games and leaves the first playable', async () => {
        game = await TestGame.create({ playerCount: 5 });
        const firstGameId = game.gameId;
        const manager = game.manager;

        const created = new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('second game was not created')), DEFAULT_TIMEOUT);
            manager.socket.once('gameCreated', ({ gameId }: { gameId: string }) => {
                clearTimeout(timer);
                resolve(gameId);
            });
        });
        manager.socket.emit('createGame');
        const secondGameId = await created;

        expect(secondGameId).not.toBe(firstGameId);
        expect(manager.errors).toHaveLength(0);
        // The socket still sees the game it is a player of; the harness only updates its id.
        expect(manager.state!.gameId).toBe(firstGameId);
        expect(manager.state!.players).toHaveLength(5);
        for (const c of connected(game)) {
            expect(c.state!.gameId).toBe(firstGameId);
            expect(c.state!.phase).toBe(Phase.LOBBY);
        }

        // The second game is real: a fresh client can join it and sees only its own seat.
        const joiner = await connectExtra(game.server.url);
        joiner.socket.emit('joinGame', { gameId: secondGameId, playerUUID: null });
        await joiner.waitFor((s) => s.gameId === secondGameId && s.players.length === 1, 'second game joined');
        expect(joiner.state!.isManager).toBe(true);
        expect(joiner.state!.phase).toBe(Phase.LOBBY);

        // Playable: the first game still closes and moves on, the second is unaffected.
        manager.socket.emit('closeJoining', { gameId: firstGameId });
        await waitForAll(game, (s) => s.phase === Phase.ROLE_SELECTION, 'first game closes');
        expect(joiner.state!.phase).toBe(Phase.LOBBY);
        expect(joiner.state!.players).toHaveLength(1);
    });

    it('accepts a repeated werewolfVote from the same wolf without resolving twice', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(LYNCH_ROLES);
        await waitForAll(game, (s) => s.activeNightRole === Role.WEREWOLF, 'wolf turn');

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const [wolfA, wolfB] = wolves as [Client, Client];
        const victim = game.clientsWithRole(Role.VILLAGER)[0]!;

        wolfA.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: victim.playerUUID });
        await wolfA.waitFor((s) => s.werewolfVotes !== null, 'first vote recorded');
        const errorsBeforeReplay = wolfA.errors.length;
        wolfA.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: victim.playerUUID });
        await wolfA.emitWithWait('werewolfVote', { gameId: game.gameId, targetUUID: victim.playerUUID }, 'second vote from the same wolf');

        expect(wolfA.errors.length).toBe(errorsBeforeReplay);
        expect(wolfA.state!.activeNightRole).toBe(Role.WEREWOLF);
        expect(wolfA.state!.werewolfVotes).toEqual({ [wolfA.playerUUID!]: victim.playerUUID });

        // The second wolf is the only one who can finish the turn.
        wolfB.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: victim.playerUUID });
        await waitForAll(game, (s) => s.activeNightRole === Role.SEER, 'exactly one resolution');
        expect(wolfA.state!.werewolfVictim).toBe(victim.playerUUID);
    });
});

// --- concurrency ---

describe('protocol: concurrency', () => {
    it('resolves simultaneous werewolf votes exactly once, with one victim at dawn', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(LYNCH_ROLES);
        await waitForAll(game, (s) => s.activeNightRole === Role.WEREWOLF, 'wolf turn');

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const seer = game.clientsWithRole(Role.SEER)[0]!;
        expect(wolves).toHaveLength(2);

        // All living wolves emit in the same tick.
        const advances = wolves.map((wolf) => {
            const waiter = wolf.waitFor(
                (s) => s.activeNightRole !== Role.WEREWOLF || s.phase !== Phase.NIGHT,
                'simultaneous wolf votes resolve',
            );
            wolf.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: seer.playerUUID });
            return waiter;
        });
        await Promise.all(advances);

        await waitForAll(game, (s) => s.activeNightRole === Role.SEER, 'seer turn everywhere');
        for (const wolf of wolves) {
            expect(wolf.errors).toHaveLength(0);
            expect(wolf.state!.werewolfVotes).toEqual({
                [wolves[0]!.playerUUID!]: seer.playerUUID,
                [wolves[1]!.playerUUID!]: seer.playerUUID,
            });
            expect(wolf.state!.werewolfVictim).toBe(seer.playerUUID);
            expect(wolf.state!.players.every((p) => p.isAlive)).toBe(true);
        }
        // Every other client saw the same single advance and no secret.
        for (const c of connected(game)) {
            expect(c.state!.activeNightRole).toBe(Role.SEER);
            if (!wolves.includes(c)) expect(c.state!.werewolfVotes).toBeNull();
        }

        // Dawn resolves the victim once.
        seer.socket.emit('seerConfirmed', { gameId: game.gameId });
        await waitForAll(game, (s) => s.phase === Phase.SHERIFF_ELECTION, 'dawn after the kill');
        expect(deadUUIDs(game.manager.state!)).toEqual([seer.playerUUID!]);
    });

    it('resolves simultaneous day votes into exactly one lynch and one death', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(LYNCH_ROLES);
        await walkToDay(game);

        const victim = game.clientsWithRole(Role.SEER)[0]!;
        await nominateEveryone(game, aliveClients(game).find((c) => c !== victim)!, victim.playerUUID);

        const voters = aliveClients(game);
        expect(voters).toHaveLength(6);
        const votes = new Map<Client, string | false>(voters.map((c) => [c, victim.playerUUID!]));
        // The victim also votes (for itself) so no one abstains and the ballot is unambiguous.
        await voteEveryone(game, votes);

        await waitForAll(
            game,
            (s) => s.lynchDone && s.votedOutUUID === victim.playerUUID,
            'simultaneous ballots resolved',
        );
        const manager = game.manager;
        expect(deadUUIDs(manager.state!)).toEqual([victim.playerUUID!]);
        expect(manager.state!.voteResults).not.toBeNull();
        for (const c of connected(game)) {
            expect(c.state!.votedOutUUID).toBe(victim.playerUUID);
            expect(c.errors).toHaveLength(0);
            expect(c.state!.lynchDone).toBe(true);
        }

        // Playable: exactly one GM step leaves the day.
        await advance(game, (s) => s.phase === Phase.NIGHT, 'night after the simultaneous lynch');
    });

    it('advancing while a wolf vote is in flight advances exactly one sub-turn and kills nobody', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(LYNCH_ROLES);
        await walkToDay(game);
        await advance(game, (s) => s.lynchDone, 'empty lynch resolved');
        await advance(game, (s) => s.phase === Phase.NIGHT, 'night one starts');
        await waitForAll(game, (s) => s.activeNightRole === Role.WEREWOLF, 'night one wolf turn');
        expect(game.manager.state!.phase).toBe(Phase.NIGHT);
        expect(game.manager.state!.activeNightRole).toBe(Role.WEREWOLF);

        const manager = game.manager;
        const wolf = game.clientsWithRole(Role.WEREWOLF)[0]!;
        const target = aliveClients(game).find((c) => c.state!.role !== Role.WEREWOLF)!;
        const errorsBefore = wolf.errors.length;

        // Same tick: one wolf vote (which alone cannot resolve the round) and the GM step.
        const settled = manager.waitFor(
            (s) => s.phase !== Phase.NIGHT || s.activeNightRole !== Role.WEREWOLF,
            'race settles',
        );
        wolf.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: target.playerUUID });
        manager.socket.emit('managerAdvance', { gameId: game.gameId });
        const after = await settled;
        await waitForAll(
            game,
            (s) => s.phase === after.phase && s.activeNightRole === after.activeNightRole,
            'race state everywhere',
        );

        // Deterministic: one wolf vote cannot finish the round, so whoever the server processes
        // first, exactly one GM step lands on the seer turn. The vote is either recorded
        // (GM first) or rejected (vote first) - never both applied and never a second advance.
        expect(after.activeNightRole).toBe(Role.SEER);
        expect(after.phase).toBe(Phase.NIGHT);
        expect(deadUUIDs(after)).toEqual([]);
        expect(wolf.errors.length - errorsBefore).toBeLessThanOrEqual(1);
        for (const c of connected(game)) {
            expect(c.state!.phase).toBe(Phase.NIGHT);
            expect(c.state!.activeNightRole).toBe(Role.SEER);
        }

        // Playable: the seer closes the night; with at most one wolf vote there is no victim.
        game.clientsWithRole(Role.SEER)[0]!.socket.emit('seerConfirmed', { gameId: game.gameId });
        await waitForAll(game, (s) => s.phase === Phase.DAY, 'night ends after the race');
        expect(deadUUIDs(game.manager.state!)).toEqual([]);
    });
});

// --- multi-game isolation ---

describe('protocol: multi-game isolation', () => {
    it('keeps two simultaneous games in different phases, seats and names apart', async () => {
        game = await TestGame.create({ playerCount: 5 });
        const gameA = game;
        const second = await createExtraGame(game.server.url, 6);
        const managerB = second.clients.find((c) => c.state?.isManager)!;

        expect(gameA.manager.state!.phase).toBe(Phase.LOBBY);
        expect(gameA.manager.state!.players).toHaveLength(5);
        expect(managerB.state!.phase).toBe(Phase.LOBBY);
        expect(managerB.state!.players).toHaveLength(6);
        expect(managerB.state!.gameId).toBe(second.gameId);

        // No seat ever appears in the other game's snapshot.
        const uuidsA = new Set(gameA.manager.state!.players.map((p) => p.playerUUID));
        const uuidsB = new Set(managerB.state!.players.map((p) => p.playerUUID));
        expect([...uuidsA].filter((uuid) => uuidsB.has(uuid))).toEqual([]);
        expect(new Set([...uuidsA, ...uuidsB]).size).toBe(11);

        // Same display name in both games is kept apart by seat, not by name.
        const namedA = gameA.clients[1]!;
        const namedB = second.clients[1]!;
        namedA.socket.emit('changeName', { gameId: gameA.gameId, playerName: 'Ben' });
        await namedA.waitFor((s) => s.displayName === 'Ben', 'Ben in game A');
        namedB.socket.emit('changeName', { gameId: second.gameId, playerName: 'Ben' });
        await namedB.waitFor((s) => s.displayName === 'Ben', 'Ben in game B');
        expect(gameA.manager.state!.players.filter((p) => p.displayName === 'Ben')).toHaveLength(1);
        expect(managerB.state!.players.filter((p) => p.displayName === 'Ben')).toHaveLength(1);
        expect(gameA.manager.state!.players.find((p) => p.displayName === 'Ben')!.playerUUID).not.toBe(
            managerB.state!.players.find((p) => p.displayName === 'Ben')!.playerUUID,
        );

        // A socket of one game can never act in the other, even with the right game id.
        const crossMessage = await emitExpectError(
            namedA,
            'changeName',
            { gameId: second.gameId, playerName: 'intruder' },
            'game A socket acts in game B',
        );
        expect(crossMessage).toMatch(/not found/i);
        await emitExpectError(
            namedB,
            'nominate',
            { gameId: gameA.gameId, nominationUUID: false },
            'game B socket acts in game A',
        );

        // Drive game B to NIGHT while game A stays in the LOBBY.
        managerB.socket.emit('closeJoining', { gameId: second.gameId });
        await Promise.all(second.clients.map((c) => c.waitForPhase(Phase.ROLE_SELECTION)));
        managerB.socket.emit('roleDistribution', { gameId: second.gameId, roles: LYNCH_ROLES });
        await Promise.all(second.clients.map((c) => c.waitForPhase(Phase.DISTRIBUTION)));
        managerB.socket.emit('startGame', { gameId: second.gameId });
        await Promise.all(second.clients.map((c) => c.waitForPhase(Phase.NIGHT)));

        expect(gameA.manager.state!.phase).toBe(Phase.LOBBY);
        expect(gameA.manager.state!.players).toHaveLength(5);
        expect(managerB.state!.phase).toBe(Phase.NIGHT);
        expect(managerB.state!.players).toHaveLength(6);
        expect(managerB.state!.players.some((p) => p.displayName === 'intruder')).toBe(false);

        // A phase change in A is invisible to B, and neither snapshot contains foreign seats.
        gameA.manager.socket.emit('closeJoining', { gameId: gameA.gameId });
        await waitForAll(gameA, (s) => s.phase === Phase.ROLE_SELECTION, 'game A closes joining');
        expect(managerB.state!.phase).toBe(Phase.NIGHT);
        expect(managerB.state!.players).toHaveLength(6);
        expect(managerB.state!.players.some((p) => uuidsA.has(p.playerUUID))).toBe(false);
        expect(gameA.manager.state!.players.some((p) => uuidsB.has(p.playerUUID))).toBe(false);
    });
});

// --- name handling (server side; the frontend escapes for display) ---

describe('protocol: name handling', () => {
    it('trims and truncates names, keeps unicode and HTML verbatim, and allows duplicates and empties', async () => {
        game = await TestGame.create({ playerCount: 6 });
        const named = game.clients[1]!;
        const duplicate = game.clients[2]!;

        expect(MAX_NAME_LENGTH).toBe(40);
        const longName = 'x'.repeat(200);
        const unicodeName = 'Ben 🐺🔥 Ω';
        const htmlName = '<img src=x onerror=alert(1)>';

        // Strings are accepted, trimmed, and only then truncated.
        const changes: [string, string][] = [
            ['  Ben  ', 'Ben'],
            [longName, 'x'.repeat(MAX_NAME_LENGTH)],
            [` ${unicodeName} `, unicodeName],
            [htmlName, htmlName],
        ];
        for (const [sent, expected] of changes) {
            const errorsBefore = named.errors.length;
            named.socket.emit('changeName', { gameId: game.gameId, playerName: sent });
            await named.waitFor((s) => s.displayName === expected, `name normalised (${expected.slice(0, 8)}…)`);
            expect(named.errors.length).toBe(errorsBefore);
            expect(named.state!.displayName).toBe(expected);
        }
        expect(named.state!.displayName).toHaveLength(htmlName.length);
        expect(typeof named.state!.displayName).toBe('string');

        // The boundary: exactly MAX_NAME_LENGTH is kept, one more is cut.
        const exact = 'a'.repeat(MAX_NAME_LENGTH);
        named.socket.emit('changeName', { gameId: game.gameId, playerName: exact });
        await named.waitFor((s) => s.displayName === exact, 'exact-length name');
        expect(named.state!.displayName).toHaveLength(MAX_NAME_LENGTH);
        const overLength = 'c'.repeat(MAX_NAME_LENGTH + 1);
        named.socket.emit('changeName', { gameId: game.gameId, playerName: overLength });
        await named.waitFor((s) => s.displayName === 'c'.repeat(MAX_NAME_LENGTH), 'over-length name truncated');
        expect(named.state!.displayName).toHaveLength(MAX_NAME_LENGTH);

        // Duplicate display names are allowed: seats, not names, identify players.
        named.socket.emit('changeName', { gameId: game.gameId, playerName: exact });
        await named.waitFor((s) => s.displayName === exact, 'named seat back to the shared name');
        duplicate.socket.emit('changeName', { gameId: game.gameId, playerName: exact });
        await duplicate.waitFor((s) => s.displayName === exact, 'duplicate name accepted');
        const manager = game.manager;
        await manager.waitFor(
            (s) => s.players.filter((p) => p.displayName === exact).length === 2,
            'manager sees both identical names',
        );
        expect(manager.state!.players.filter((p) => p.displayName === exact)).toHaveLength(2);

        // Whitespace only trims to the empty string, which is allowed on purpose.
        const whitespaceSeat = game.clients[3]!;
        whitespaceSeat.socket.emit('changeName', { gameId: game.gameId, playerName: '   ' });
        await whitespaceSeat.waitFor((s) => s.displayName === '', 'whitespace trims to empty');

        const emptySeat = game.clients[4]!;
        const errorsBeforeEmpty = emptySeat.errors.length;
        emptySeat.socket.emit('changeName', { gameId: game.gameId, playerName: '' });
        await emptySeat.waitFor((s) => s.displayName === '', 'empty name accepted');
        expect(emptySeat.errors.length).toBe(errorsBeforeEmpty);

        // closeJoining is the only place unnamed seats are repaired.
        await game.closeJoining();
        expect(manager.state!.players.filter((p) => p.displayName === exact)).toHaveLength(2);
        const repaired = manager.state!.players.filter((p) => /^Unnamed Player \d+$/.test(p.displayName));
        // The whitespace seat, the empty seat, and the two seats that never had a name.
        expect(repaired).toHaveLength(4);
        expect(new Set(repaired.map((p) => p.displayName)).size).toBe(4);
        expect(manager.state!.players.every((p) => typeof p.displayName === 'string' && p.displayName.length > 0)).toBe(true);
    });

    it('rejects a name change after the game started and keeps the old name', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(LYNCH_ROLES);
        const player = game.clients[1]!;
        const nameBefore = player.state!.displayName;
        const phaseBefore = player.state!.phase;

        const message = await emitExpectError(
            player,
            'changeName',
            { gameId: game.gameId, playerName: 'late arrival' },
            'changeName during the night',
        );
        expect(message).toMatch(/LOBBY/i);
        expect(player.state!.phase).toBe(phaseBefore);
        expect(player.state!.displayName).toBe(nameBefore);
        for (const c of connected(game)) {
            expect(c.state!.players.some((p) => p.displayName === 'late arrival')).toBe(false);
        }

        // Playable: the GM can still advance the night.
        await advanceNightTurn(game);
    });

    it('rejects a missing or non-string name without touching the seat, then repairs the empty name', async () => {
        game = await TestGame.create({ playerCount: 6 });
        const player = game.clients[1]!;

        // A non-object payload is rejected centrally, before the handler runs.
        const payloadMessage = await emitExpectError(player, 'changeName', null, 'changeName null payload');
        expect(payloadMessage).toMatch(/Malformed event payload/);

        // A missing or wrong-typed name is rejected before anything is written.
        const cases: [unknown, RegExp, string][] = [
            [undefined, /string, got undefined/i, 'missing name'],
            [42, /string, got number/i, 'numeric name'],
            [{}, /string, got object/i, 'object name'],
            [[], /string, got object/i, 'array name'],
            [true, /string, got boolean/i, 'boolean name'],
        ];
        for (const [playerName, expected, label] of cases) {
            const message = await emitExpectError(
                player,
                'changeName',
                { gameId: game.gameId, playerName },
                label,
            );
            expect(message, label).toMatch(expected);
            expect(player.state!.displayName, label).toBe('');
        }
        expect(player.errors).toHaveLength(1 + cases.length);
        expect(player.state!.players).toHaveLength(6);
        expect(player.state!.phase).toBe(Phase.LOBBY);

        // A valid string still works (trimmed), and the empty string is allowed on purpose.
        player.socket.emit('changeName', { gameId: game.gameId, playerName: '  Ada  ' });
        await player.waitFor((s) => s.displayName === 'Ada', 'valid name after the rejected ones');
        player.socket.emit('changeName', { gameId: game.gameId, playerName: '' });
        await player.waitFor((s) => s.displayName === '', 'empty name allowed');

        await game.closeJoining();
        const repaired = game.manager.state!.players.find((p) => p.playerUUID === player.playerUUID)!;
        expect(repaired.isAlive).toBe(true);
        expect(repaired.displayName).toMatch(/^Unnamed Player \d+$/);
        expect(player.state!.phase).toBe(Phase.ROLE_SELECTION);
    });
});

// --- socket churn ---

describe('protocol: socket churn', () => {
    it('keeps one seat when a client reconnects five times with its playerUUID', async () => {
        game = await TestGame.create({ playerCount: 6 });
        const churned = game.clients[1]!;
        const playerUUID = churned.playerUUID!;
        churned.close();

        for (let i = 0; i < 5; i++) {
            const client = await connectExtra(game.server.url);
            client.socket.emit('joinGame', { gameId: game.gameId, playerUUID });
            await client.waitFor((s) => s.playerUUID === playerUUID, `rejoin ${i + 1}`);
            client.close();
        }

        const manager = game.manager;
        expect(manager.state!.players).toHaveLength(6);
        expect(manager.state!.players.filter((p) => p.playerUUID === playerUUID)).toHaveLength(1);

        // The count is still exactly what roleDistribution needs: the game can start.
        manager.socket.emit('closeJoining', { gameId: game.gameId });
        await waitForAll(game, (s) => s.phase === Phase.ROLE_SELECTION, 'lobby closes after churn');
        manager.socket.emit('roleDistribution', { gameId: game.gameId, roles: LYNCH_ROLES });
        await waitForAll(game, (s) => s.phase === Phase.DISTRIBUTION, 'roles dealt after churn');
        manager.socket.emit('startGame', { gameId: game.gameId });
        await waitForAll(game, (s) => s.phase === Phase.NIGHT, 'night after churn');

        expect(manager.errors).toHaveLength(0);
        expect(manager.state!.players).toHaveLength(6);
        expect(new Set(manager.state!.players.map((p) => p.playerUUID)).size).toBe(6);
        // Five visible roles plus the one dealt to the disconnected seat that is kept for rejoin.
        expect(connected(game).filter((c) => c.state!.role !== null)).toHaveLength(5);
    });

    it('ignores a second joinGame from the same socket instead of adding a second seat', async () => {
        game = await TestGame.create({ playerCount: 5 });
        const client = await connectExtra(game.server.url);

        client.socket.emit('joinGame', { gameId: game.gameId, playerUUID: null });
        await client.waitFor(() => client.playerUUID !== null, 'first join');
        const firstUUID = client.playerUUID!;
        const playerCount = client.state!.players.length;
        expect(playerCount).toBe(6);

        // A second join from a socket that already holds a seat. The documented contract is one
        // socket = one player; the server currently creates a second player sharing the socket id.
        await client
            .emitWithWait('joinGame', { gameId: game.gameId, playerUUID: null }, 'duplicate joinGame', 1500)
            .catch(() => null);

        const diagnosis =
            `payload {"gameId":${JSON.stringify(game.gameId)},"playerUUID":null} emitted twice on one socket; ` +
            `first uuid ${firstUUID}, socket now shows uuid ${client.playerUUID}, ` +
            `players ${playerCount} -> ${client.state!.players.length}`;
        // RED: both of these fail today. Do not weaken; the server must reject or ignore the
        // repeat (a second seat steals a role at roleDistribution and points at the same socket).
        expect.soft(client.playerUUID, diagnosis).toBe(firstUUID);
        expect.soft(client.state!.players, diagnosis).toHaveLength(playerCount);
    });
});

// --- game ids ---

describe('protocol: game ids', () => {
    it('creates unique ids and rejects unknown, empty, overlong and wrong-case ids', async () => {
        game = await TestGame.create({ playerCount: 5 });
        const manager = game.manager;
        const ids: string[] = [];

        for (let i = 0; i < 20; i++) {
            const host = await connectExtra(game.server.url);
            const created = new Promise<string>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`game ${i} was not created`)), DEFAULT_TIMEOUT);
                host.socket.once('gameCreated', ({ gameId }: { gameId: string }) => {
                    clearTimeout(timer);
                    resolve(gameId);
                });
            });
            host.socket.emit('createGame');
            ids.push(await created);
        }

        expect(new Set(ids).size).toBe(20);
        expect(new Set([...ids, game.gameId]).size).toBe(21);
        for (const id of ids) {
            expect(id).toMatch(/^[A-Z0-9]{4}$/);
        }

        const stranger = await connectExtra(game.server.url);

        // Case sensitive: the lookup is a Map key, so a lowercased id must not resolve.
        const casedId = [game.gameId, ...ids].find((id) => id !== id.toLowerCase());
        if (casedId) {
            const message = await emitExpectError(
                stranger,
                'joinGame',
                { gameId: casedId.toLowerCase(), playerUUID: null },
                'lowercase game id',
            );
            expect(message).toContain(casedId.toLowerCase());
            expect(message).toMatch(/not found/i);
        }

        const emptyId = await emitExpectError(
            stranger,
            'joinGame',
            { gameId: '', playerUUID: null },
            'empty game id',
        );
        expect(emptyId).toMatch(/not found/i);

        const longId = 'A'.repeat(5000);
        const longIdError = await emitExpectError(
            stranger,
            'joinGame',
            { gameId: longId, playerUUID: null },
            'overlong game id',
        );
        expect(longIdError).toMatch(/not found/i);

        // None of the rejected joins created a seat in the original game.
        expect(stranger.playerUUID).toBeNull();
        expect(manager.state!.players).toHaveLength(5);

        // Playable: the original game is untouched and still closes.
        manager.socket.emit('closeJoining', { gameId: game.gameId });
        await waitForAll(game, (s) => s.phase === Phase.ROLE_SELECTION, 'original game still playable');
        expect(manager.state!.players).toHaveLength(5);
    });
});
