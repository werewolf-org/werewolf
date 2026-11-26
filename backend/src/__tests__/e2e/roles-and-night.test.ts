import { describe, it, expect, afterEach } from 'vitest';
import { TestGame } from './harness.js';
import type { Client, Snapshot } from './harness.js';
import { Phase } from '@shared/phases.js';
import { Role, ROLES } from '@shared/roles.js';

// Role and night edge cases over the real socket contract.
//
// This file owns the *composition* and *order* dimensions that game-flow.test.ts deliberately
// keeps out of its happy paths: extreme player counts, absent roles, cupid chains, witch
// self-heal/poison overlap, red-lady targeting, split wolf votes, multi-round drift.
//
// Roles are dealt at random, so every scenario discovers its actors from `state.role` and
// never assumes a seat. The night is driven from `shared/roles.ts` (`nightOrder`, lower
// first), so a change to the order is picked up here.
//
// Two rules that this file first exposed as broken live in the last describe as regression pins:
//  - a werewolf cannot vote for a packmate (rejected like a self-vote), so a 3-wolf pack can
//    never put a majority on one of its own: test 27;
//  - the witch's poison kills the red lady; she only escapes a werewolf attack aimed at herself: test 26.

// --- compositions (only *which* roles exist; never who holds them) ---

// 4 players: the smallest legal game, and the only game where the werewolf is the sole
// waking role.
const FOUR_ONE_WOLF: Record<string, number> = {
    [Role.WEREWOLF]: 1,
    [Role.VILLAGER]: 3,
};

// 10 players: a pack that needs three votes is the largest composition the app supports
// without inventing more roles.
const TEN_THREE_WOLVES: Record<string, number> = {
    [Role.WEREWOLF]: 3,
    [Role.SEER]: 1,
    [Role.WITCH]: 1,
    [Role.CUPID]: 1,
    [Role.VILLAGER]: 4,
};

// 8 players: every waking role in the game at once, so the full nightOrder runs.
const ALL_WAKERS: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.SEER]: 1,
    [Role.WITCH]: 1,
    [Role.CUPID]: 1,
    [Role.RED_LADY]: 1,
    [Role.VILLAGER]: 2,
};

// 6 players: no cupid and no witch, so the night is Werewolf -> Seer and nothing else.
const NO_CUPID_NO_WITCH: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.SEER]: 1,
    [Role.VILLAGER]: 3,
};

// 6 players: the first-night roles (cupid) plus the witch, for the night-2 order checks.
const SIX_WITH_CUPID: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.SEER]: 1,
    [Role.WITCH]: 1,
    [Role.CUPID]: 1,
    [Role.VILLAGER]: 1,
};

// 6 players: red lady plus villagers only, so the pack has clean targets.
const SIX_RED_LADY: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.RED_LADY]: 1,
    [Role.VILLAGER]: 3,
};

// 7 players: two lovers, a heal and a poison in the same night, and a spare villager pair.
const SEVEN_POTION_CHAIN: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.CUPID]: 1,
    [Role.WITCH]: 1,
    [Role.SEER]: 1,
    [Role.VILLAGER]: 2,
};

// 5 players: the smallest game where the lover chain can take the whole pack down at dawn.
const FIVE_ALL_WOLVES_DIE: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.CUPID]: 1,
    [Role.WITCH]: 1,
    [Role.VILLAGER]: 1,
};

// 6 players: a little girl that is not supposed to wake at all.
const SIX_WITH_LITTLE_GIRL: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.SEER]: 1,
    [Role.LITTLE_GIRL]: 1,
    [Role.VILLAGER]: 2,
};

let game: TestGame | null = null;

afterEach(async () => {
    await game?.close();
    game = null;
});

// --- local helpers (the harness is owned elsewhere; nothing here needs a harness change) ---

/** The one client holding `role`. Fails the test if the count is not exactly one. */
function only(target: TestGame, role: Role): Client {
    const found = target.clientsWithRole(role);
    expect(found.length, `expected exactly one client with role ${role}`).toBe(1);
    return found[0]!;
}

/** Sorted UUIDs of every corpse in a snapshot. */
function deadUUIDs(state: Snapshot): string[] {
    return state.players
        .filter((p) => !p.isAlive)
        .map((p) => p.playerUUID)
        .sort();
}

/** Roles that are alive right now, read from the snapshots (own role, public liveness). */
function livingRoles(target: TestGame): Set<string> {
    const roles = new Set<string>();
    for (const client of target.clients) {
        const entry = client.state?.players.find((p) => p.playerUUID === client.playerUUID);
        if (entry?.isAlive && client.state?.role) roles.add(client.state.role);
    }
    return roles;
}

/** Roles that wake up this night, in `ROLES[...].nightOrder` order (lower first). */
function nightOrderFor(target: TestGame, round: number): Role[] {
    const roles = livingRoles(target);
    return (Object.values(Role) as Role[])
        .filter((role) => {
            const def = ROLES[role];
            if (!def.wakesUp) return false;
            if (!roles.has(role)) return false;
            if (def.onlyFirstNight && round > 0) return false;
            return true;
        })
        .sort((a, b) => ROLES[a].nightOrder - ROLES[b].nightOrder);
}

/**
 * The sequence of published night sub-turns a client received from `fromIndex` on,
 * collapsing repeats of the same role (every action within a turn re-broadcasts it).
 */
function nightSequence(client: Client, fromIndex: number): string[] {
    const sequence: string[] = [];
    for (const state of client.history.slice(fromIndex)) {
        if (state.phase !== Phase.NIGHT || !state.activeNightRole) continue;
        if (sequence[sequence.length - 1] !== state.activeNightRole) sequence.push(state.activeNightRole);
    }
    return sequence;
}

/** Runs `check` on every snapshot matching `filter`, for every listed client. */
function eachSnapshot(
    clients: Client[],
    filter: (state: Snapshot) => boolean,
    check: (state: Snapshot, label: string) => void,
): void {
    for (const client of clients) {
        client.history.forEach((state, index) => {
            if (!filter(state)) return;
            check(state, `player ${client.playerUUID} snapshot #${index} (${state.phase})`);
        });
    }
}

/** A corpse never comes back: the dead set may grow, never shrink, across one client's history. */
function expectDeathsMonotonic(client: Client): void {
    let previous = new Set<string>();
    client.history.forEach((state, index) => {
        const now = new Set(deadUUIDs(state));
        for (const uuid of previous) {
            expect(now.has(uuid), `player ${client.playerUUID} snapshot #${index}: ${uuid} resurrected`).toBe(true);
        }
        previous = now;
    });
}

/**
 * Emits an event the server is expected to reject and resolves with its error message.
 * The harness records the error in `client.errors` as well, so assert the count separately.
 */
async function rejection(client: Client, event: string, payload: unknown, label: string): Promise<string> {
    const before = client.errors.length;
    const message = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`Timed out waiting for the server error after "${label}"`)),
            2000,
        );
        client.socket.once('error', (data: { message: string }) => {
            clearTimeout(timer);
            resolve(data.message);
        });
        client.socket.emit(event, payload);
    });
    expect(client.errors.length, `the harness must have recorded "${label}"`).toBeGreaterThan(before);
    return message;
}

interface NightPlan {
    /** The two players cupid binds; both confirm the bond. Required when a cupid wakes. */
    lovers?: [Client, Client];
    /** Every wolf votes for this player. */
    wolfTarget?: Client;
    /** Per-wolf target in `aliveClients()` order; overrides `wolfTarget`. */
    wolfVotes?: Client[];
    /** Whom the seer looks at. Omitted means the seer confirms without a reveal. */
    seerTarget?: Client;
    /** Witch usage. Omitted means the witch passes. */
    witch?: { heal?: boolean; kill?: Client; expectError?: RegExp };
    /**
     * Red lady host. `expectError` emits a rejected visit first (a self-visit, a corpse);
     * `retry` is the legal host she then picks, because a rejection does not advance the turn.
     */
    redLady?: { target: Client; expectError?: RegExp; retry?: Client };
}

interface NightRun {
    /** The order the rules say must happen tonight. */
    order: Role[];
    /** The order the manager actually received. */
    sequence: string[];
    /** Phase reached at dawn. */
    dawn: Phase;
    seerRevealUUID: string | null;
    seerRevealRole: string | null;
    redLadySleepoverUUID: string | null;
    /** The pack victim, as seen mid-night by a wolf or the witch (null if nobody died to the pack). */
    werewolfVictim: string | null;
}

/**
 * Index of the first snapshot of the night that is currently in progress: the trailing run
 * of snapshots that are in NIGHT with an active role. Called at the night's opening turn.
 */
function nightStartIndex(client: Client): number {
    let index = client.history.length;
    for (let i = client.history.length - 1; i >= 0; i--) {
        const state = client.history[i]!;
        if (state.phase !== Phase.NIGHT || !state.activeNightRole) break;
        index = i;
    }
    return index;
}

/**
 * Plays exactly one night: every living role takes its turn in `nightOrder`, using the real
 * action contract. Asserts the sub-turn sequence from *every* client's history, so a
 * divergent snapshot fails here instead of silently.
 */
async function playNight(target: TestGame, round: number, plan: NightPlan = {}): Promise<NightRun> {
    const starts = new Map<Client, number>(target.clients.map((c) => [c, nightStartIndex(c)] as const));
    const order = nightOrderFor(target, round);
    expect(order.length, 'the night needs at least one role that wakes up').toBeGreaterThan(0);
    expect(target.clients[0]!.state?.activeNightRole, 'the night starts with the earliest waking role').toBe(order[0]);

    let seerRevealUUID: string | null = null;
    let seerRevealRole: string | null = null;
    let redLadySleepoverUUID: string | null = null;
    let werewolfVictim: string | null = null;

    for (const role of order) {
        await Promise.all(target.clients.map((c) => c.waitForTurn(role)));

        const actors = target.aliveClients().filter((c) => c.state?.role === role);
        expect(actors.length, `an alive ${role} is needed for its turn`).toBeGreaterThan(0);

        switch (role) {
            case Role.CUPID: {
                const lovers = plan.lovers;
                if (!lovers) throw new Error('night plan is missing the lover pair for cupid');
                const [first, second] = lovers;
                const cupid = actors[0]!;
                cupid.socket.emit('bindLovers', {
                    gameId: target.gameId,
                    firstPlayerUUID: first.playerUUID,
                    secondPlayerUUID: second.playerUUID,
                });
                await cupid.waitFor((s) => s.cupidFirstLoverUUID !== null, 'cupid bound the lovers');
                first.socket.emit('confirmLoverBond', { gameId: target.gameId });
                await cupid.waitFor(
                    (s) => s.cupidFirstLoverConfirmed || s.cupidSecondLoverConfirmed,
                    'one lover confirmed the bond',
                );
                second.socket.emit('confirmLoverBond', { gameId: target.gameId });
                break;
            }
            case Role.RED_LADY: {
                const host = plan.redLady;
                if (!host) throw new Error('night plan is missing a red lady host');
                const redLady = actors[0]!;
                if (host.expectError) {
                    const message = await rejection(
                        redLady,
                        'sleepover',
                        { gameId: target.gameId, sleepoverUUID: host.target.playerUUID },
                        'red lady sleepover was rejected',
                    );
                    expect(message).toMatch(host.expectError);
                    if (host.retry) {
                        redLady.socket.emit('sleepover', {
                            gameId: target.gameId,
                            sleepoverUUID: host.retry.playerUUID,
                        });
                        const seen = await redLady.waitFor(
                            (s) => s.redLadySleepoverUUID === host.retry!.playerUUID,
                            'red lady picked a legal host after the rejection',
                        );
                        redLadySleepoverUUID = seen.redLadySleepoverUUID;
                    }
                } else {
                    redLady.socket.emit('sleepover', {
                        gameId: target.gameId,
                        sleepoverUUID: host.target.playerUUID,
                    });
                    const seen = await redLady.waitFor(
                        (s) => s.redLadySleepoverUUID === host.target.playerUUID,
                        'red lady chose a host',
                    );
                    redLadySleepoverUUID = seen.redLadySleepoverUUID;
                }
                break;
            }
            case Role.WEREWOLF: {
                const targets = plan.wolfVotes ?? actors.map(() => plan.wolfTarget!);
                if (targets.length !== actors.length || targets.some((t) => !t)) {
                    throw new Error('night plan must give every wolf a target');
                }
                for (let i = 0; i < actors.length; i++) {
                    const wolf = actors[i]!;
                    wolf.socket.emit('werewolfVote', {
                        gameId: target.gameId,
                        targetUUID: targets[i]!.playerUUID,
                    });
                    if (i < actors.length - 1) {
                        // Negative space: one vote is not a kill.
                        const voted = await wolf.waitFor(
                            (s) => Object.keys(s.werewolfVotes ?? {}).length >= i + 1,
                            `werewolf vote ${i + 1} recorded`,
                        );
                        expect(voted.phase).toBe(Phase.NIGHT);
                        expect(voted.activeNightRole).toBe(Role.WEREWOLF);
                        expect(voted.werewolfVictim, 'no victim until every wolf voted').toBeNull();
                    }
                }
                const resolved = await actors[0]!.waitFor(
                    (s) =>
                        s.werewolfVictim !== null ||
                        s.activeNightRole !== Role.WEREWOLF ||
                        s.phase !== Phase.NIGHT,
                    'the pack victim is resolved',
                );
                werewolfVictim = resolved.werewolfVictim;
                break;
            }
            case Role.SEER: {
                const seer = actors[0]!;
                if (plan.seerTarget) {
                    const targetUUID = plan.seerTarget.playerUUID!;
                    seer.socket.emit('revealRole', { gameId: target.gameId, revealUUID: targetUUID });
                    const revealed = await seer.waitFor(
                        (s) => s.seerRevealUUID === targetUUID,
                        'seer looked at a card',
                    );
                    expect(revealed.seerRevealRole, 'the seer learns the true role').toBe(
                        plan.seerTarget.state?.role,
                    );
                    seerRevealUUID = revealed.seerRevealUUID;
                    seerRevealRole = revealed.seerRevealRole;
                    for (const other of target.clients.filter((c) => c !== seer)) {
                        expect(
                            other.state?.seerRevealRole,
                            `${other.playerUUID} must not see the seer's reveal`,
                        ).toBeNull();
                    }
                }
                seer.socket.emit('seerConfirmed', { gameId: target.gameId });
                break;
            }
            case Role.WITCH: {
                const witch = actors[0]!;
                const usage = plan.witch;
                if (usage?.expectError) {
                    const message = await rejection(
                        witch,
                        'usePotion',
                        {
                            gameId: target.gameId,
                            heal: !!usage.heal,
                            killUUID: usage.kill?.playerUUID ?? null,
                        },
                        'witch potion was rejected',
                    );
                    expect(message).toMatch(usage.expectError);
                } else if (usage?.heal || usage?.kill) {
                    witch.socket.emit('usePotion', {
                        gameId: target.gameId,
                        heal: !!usage.heal,
                        killUUID: usage.kill?.playerUUID ?? null,
                    });
                    await witch.waitFor(
                        (s) =>
                            (usage.heal ? s.witchUsedHealingPotion : true) &&
                            (usage.kill ? s.witchUsedKillingPotion : true),
                        'witch potion was recorded',
                    );
                }
                // The witch is the only non-wolf who is shown the pack's victim.
                const seenByWitch = witch.state?.werewolfVictim ?? null;
                if (!werewolfVictim && seenByWitch) werewolfVictim = seenByWitch;
                witch.socket.emit('witchConfirms', { gameId: target.gameId });
                break;
            }
            default:
                throw new Error(`no test driver for the waking role ${role}`);
        }
    }

    const dawn = await target.manager.waitFor((s) => s.phase !== Phase.NIGHT, `dawn after round ${round}`);
    await target.waitForPhaseEverywhere(dawn.phase);

    // The whole point of the driver: the published order, seen by every phone, is the
    // order the rules define.
    for (const client of target.clients) {
        expect(
            nightSequence(client, starts.get(client)!),
            `night ${round}: the sub-turns received by ${client.playerUUID}`,
        ).toEqual(order);
    }

    return {
        order,
        sequence: nightSequence(target.manager, starts.get(target.manager)!),
        dawn: dawn.phase,
        seerRevealUUID,
        seerRevealRole,
        redLadySleepoverUUID,
        werewolfVictim,
    };
}

/** One nominate per living player, then wait until every client agrees nominations are in. */
async function nominateAll(
    target: TestGame,
    targetFor: (client: Client, alive: Client[]) => Client | false,
): Promise<void> {
    const alive = target.aliveClients();
    expect(alive.length, 'somebody has to nominate').toBeGreaterThan(0);
    for (const client of alive) {
        const nominee = targetFor(client, alive);
        client.socket.emit('nominate', {
            gameId: target.gameId,
            nominationUUID: nominee ? nominee.playerUUID : false,
        });
    }
    await Promise.all(
        target.clients.map((c) => c.waitFor((s) => s.nominationsFinished, 'every living player nominated')),
    );
}

/** One vote per living player, then wait until `done` holds on every client. */
async function voteAll(
    target: TestGame,
    targetFor: (client: Client) => Client | false,
    done: (state: Snapshot) => boolean,
    label: string,
): Promise<void> {
    for (const client of target.aliveClients()) {
        const voteTarget = targetFor(client);
        client.socket.emit('vote', {
            gameId: target.gameId,
            voteTargetUUID: voteTarget ? voteTarget.playerUUID : false,
        });
    }
    await Promise.all(target.clients.map((c) => c.waitFor(done, label)));
}

/** Nominates `victim`, has everybody vote for them, waits for the lynch to resolve. */
async function lynch(target: TestGame, victim: Client): Promise<void> {
    const alive = target.aliveClients();
    expect(alive, 'the lynch victim must be alive').toContain(victim);
    const nominator = alive.find((c) => c !== victim) ?? victim;
    await nominateAll(target, (client) => (client === nominator ? victim : false));
    await voteAll(target, () => victim, (s) => s.lynchDone, `lynch of ${victim.playerUUID} resolved`);
    for (const client of target.clients) {
        expect(client.state?.votedOutUUID, `${client.playerUUID} sees the lynched player`).toBe(victim.playerUUID);
    }
}

/** GM path: nobody is nominated, so the election resolves without a sheriff and the GM opens the day. */
async function skipSheriffElection(target: TestGame): Promise<void> {
    await target.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);
    await nominateAll(target, () => false);
    await target.manager.waitFor(
        (s) => s.phase === Phase.SHERIFF_ELECTION && s.sheriffElectionDone,
        'sheriff election resolved without a candidate',
    );
    target.manager.socket.emit('acceptSheriffRole', { gameId: target.gameId });
    await target.waitForPhaseEverywhere(Phase.DAY);
}

/** A day that lynches nobody: every living player abstains, then everybody is ready. */
async function passDay(target: TestGame): Promise<void> {
    await target.waitForPhaseEverywhere(Phase.DAY);
    await nominateAll(target, () => false);
    await Promise.all(target.clients.map((c) => c.waitFor((s) => s.lynchDone, 'empty nominations resolved')));
    for (const client of target.aliveClients()) {
        client.socket.emit('readyForNight', { gameId: target.gameId });
    }
    await target.waitForPhaseEverywhere(Phase.NIGHT);
}

describe('composition extremes', () => {
    it('1. 4 players with one wolf: the werewolf is the only waking role and the night still ends', async () => {
        game = await TestGame.create({ playerCount: 4 });
        await game.setupAndStart(FOUR_ONE_WOLF);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const villagers = game.clientsWithRole(Role.VILLAGER);
        expect(villagers).toHaveLength(3);

        // The very first turn is already the pack: no cupid, no seer, no witch exists.
        for (const client of game.clients) {
            expect(client.state?.activeNightRole, `${client.playerUUID} first turn`).toBe(Role.WEREWOLF);
        }

        const run = await playNight(game, 0, { wolfTarget: villagers[0]! });
        expect(run.order).toEqual([Role.WEREWOLF]);
        expect(run.sequence).toEqual([Role.WEREWOLF]);
        expect(run.dawn, 'round 0 ends in the sheriff election').toBe(Phase.SHERIFF_ELECTION);

        for (const client of game.clients) {
            const state = client.state!;
            expect(deadUUIDs(state), `${client.playerUUID} death list`).toEqual([villagers[0]!.playerUUID]);
            expect(
                state.players.find((p) => p.playerUUID === villagers[0]!.playerUUID)?.role,
                'the corpse role is public',
            ).toBe(Role.VILLAGER);
            expect(state.werewolfVotes, `${client.playerUUID} werewolf votes`).toBeNull();
        }

        game.expectNoErrors();
    });

    it('2. 10 players with three wolves: the victim only exists after the third vote', async () => {
        game = await TestGame.create({ playerCount: 10 });
        await game.setupAndStart(TEN_THREE_WOLVES);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const villagers = game.clientsWithRole(Role.VILLAGER);
        expect(wolves).toHaveLength(3);
        expect(villagers).toHaveLength(4);

        const victim = villagers[2]!;
        const run = await playNight(game, 0, {
            lovers: [villagers[0]!, villagers[1]!],
            wolfTarget: victim,
        });

        expect(run.order).toEqual([Role.CUPID, Role.WEREWOLF, Role.SEER, Role.WITCH]);
        expect(run.sequence).toEqual(run.order);
        expect(run.werewolfVictim, 'the pack victim after three unanimous votes').toBe(victim.playerUUID);
        // The driver already asserted null after votes one and two; here is the full ballot.
        eachSnapshot(
            wolves,
            (s) => s.phase === Phase.NIGHT && s.activeNightRole === Role.SEER,
            (s, where) => {
                expect(Object.keys(s.werewolfVotes ?? {}), where).toHaveLength(3);
                for (const wolf of wolves) expect(s.werewolfVotes?.[wolf.playerUUID!], where).toBe(victim.playerUUID);
            },
        );

        expect(deadUUIDs(game.manager.state!)).toEqual([victim.playerUUID]);
        expect(game.aliveClients()).toHaveLength(9);
        game.expectNoErrors();
    });

    it('3. every waking role at once: cupid, red lady, wolves, seer and witch wake in nightOrder', async () => {
        game = await TestGame.create({ playerCount: 8 });
        await game.setupAndStart(ALL_WAKERS);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const cupid = only(game, Role.CUPID);
        const redLady = only(game, Role.RED_LADY);
        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const seer = only(game, Role.SEER);
        const witch = only(game, Role.WITCH);
        const villagers = game.clientsWithRole(Role.VILLAGER);
        expect(villagers).toHaveLength(2);

        // Lovers who are not the victim; the red lady visits a wolf that is not the victim.
        const lovers: [Client, Client] = [seer, villagers[0]!];
        const run = await playNight(game, 0, {
            lovers,
            redLady: { target: wolves[0]! },
            wolfTarget: villagers[1]!,
            seerTarget: wolves[1]!,
        });

        // ROLES nightOrder: cupid 1, red lady 2, werewolf 3, seer 4, witch 5.
        expect(run.order).toEqual([Role.CUPID, Role.RED_LADY, Role.WEREWOLF, Role.SEER, Role.WITCH]);
        expect(run.sequence).toEqual(run.order);
        const nightOrders = run.sequence.map((role) => ROLES[role as Role].nightOrder);
        expect(nightOrders, 'the sequence is sorted by ROLES[].nightOrder').toEqual(
            [...nightOrders].sort((a, b) => a - b),
        );

        expect(run.redLadySleepoverUUID).toBe(wolves[0]!.playerUUID);
        expect(run.seerRevealRole).toBe(Role.WEREWOLF);
        expect(run.seerRevealUUID).toBe(wolves[1]!.playerUUID);
        expect(run.werewolfVictim).toBe(villagers[1]!.playerUUID);

        // Each role-private value is visible mid-night to its owner only.
        eachSnapshot([witch], (s) => s.phase === Phase.NIGHT && s.activeNightRole === Role.WITCH, (s, where) => {
            expect(s.werewolfVictim, where).toBe(villagers[1]!.playerUUID);
            expect(s.werewolfVotes, `${where}: the witch never sees the ballot`).toBeNull();
        });
        for (const client of game.clients.filter((c) => c !== redLady)) {
            expect(client.state?.redLadySleepoverUUID, `${client.playerUUID} sees the red lady's host`).toBeNull();
        }
        const bound = cupid.history.filter((s) => s.cupidFirstLoverUUID !== null);
        expect(bound.length).toBeGreaterThan(0);
        for (const s of bound) {
            expect([s.cupidFirstLoverUUID, s.cupidSecondLoverUUID].sort()).toEqual(
                [lovers[0].playerUUID, lovers[1].playerUUID].sort(),
            );
        }
        for (const client of game.clients.filter((c) => !lovers.includes(c) && c !== cupid)) {
            expect(client.state?.cupidFirstLoverUUID, `${client.playerUUID} sees the lovers`).toBeNull();
        }

        expect(deadUUIDs(game.manager.state!), 'only the ordered victim died').toEqual([villagers[1]!.playerUUID]);
        expect(run.dawn).toBe(Phase.SHERIFF_ELECTION);
        game.expectNoErrors();
    });

    it('4. no cupid and no witch: the absent roles are skipped and the night resolves', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(NO_CUPID_NO_WITCH);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const villagers = game.clientsWithRole(Role.VILLAGER);
        expect(villagers).toHaveLength(3);

        const run = await playNight(game, 0, { wolfTarget: villagers[0]!, seerTarget: wolves[0]! });
        expect(run.order, 'no cupid and no witch exist').toEqual([Role.WEREWOLF, Role.SEER]);
        expect(run.sequence).toEqual([Role.WEREWOLF, Role.SEER]);
        expect(run.seerRevealRole).toBe(Role.WEREWOLF);
        expect(run.dawn).toBe(Phase.SHERIFF_ELECTION);

        // Nothing about the missing roles leaks into any snapshot.
        eachSnapshot(game.clients, () => true, (s, where) => {
            expect(s.activeNightRole === Role.CUPID || s.activeNightRole === Role.WITCH, where).toBe(false);
            expect(s.cupidFirstLoverUUID, where).toBeNull();
            expect(s.cupidSelectedLovers, where).toBe(false);
            expect(s.witchUsedHealingPotion, where).toBe(false);
            expect(s.witchUsedKillingPotion, where).toBe(false);
        });

        expect(deadUUIDs(game.manager.state!)).toEqual([villagers[0]!.playerUUID]);
        game.expectNoErrors();
    });
});

describe('night order integrity', () => {
    it('5. a second night drops the first-night cupid and keeps the rest of nightOrder', async () => {
        game = await TestGame.create({ playerCount: 8 });
        await game.setupAndStart(ALL_WAKERS);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const redLady = only(game, Role.RED_LADY);
        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const seer = only(game, Role.SEER);
        const villagers = game.clientsWithRole(Role.VILLAGER);

        const firstNight = await playNight(game, 0, {
            lovers: [seer, villagers[0]!],
            redLady: { target: wolves[0]! },
            wolfTarget: villagers[1]!,
        });
        expect(firstNight.sequence[0]).toBe(Role.CUPID);
        await skipSheriffElection(game);
        await passDay(game);

        // Night 2: cupid is onlyFirstNight, so the red lady opens the night.
        expect(nightOrderFor(game, 1)).toEqual([Role.RED_LADY, Role.WEREWOLF, Role.SEER, Role.WITCH]);
        const secondNight = await playNight(game, 1, {
            redLady: { target: wolves[1]! },
            wolfTarget: only(game, Role.CUPID),
            seerTarget: wolves[0]!,
        });
        expect(secondNight.sequence).toEqual([Role.RED_LADY, Role.WEREWOLF, Role.SEER, Role.WITCH]);
        expect(secondNight.sequence, 'the cupid never wakes twice').not.toContain(Role.CUPID);
        expect(secondNight.dawn, 'only round 0 ends in an election').toBe(Phase.DAY);

        // Over the whole game, the cupid turn happened exactly once.
        const turnOnsets = game.manager.history.flatMap((s, index, history) =>
            s.phase === Phase.NIGHT &&
            s.activeNightRole === Role.CUPID &&
            history[index - 1]?.activeNightRole !== Role.CUPID
                ? [s]
                : [],
        );
        expect(turnOnsets, 'cupid turn onsets across the game').toHaveLength(1);

        expect(redLady.state?.redLadySleepoverUUID, 'night actions are cleared at dawn').toBeNull();
        game.expectNoErrors();
    });

    it('6. a role whose only player died at dawn is skipped, and the night does not stall', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_WITH_CUPID);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const seer = only(game, Role.SEER);
        const cupid = only(game, Role.CUPID);
        const villager = only(game, Role.VILLAGER);

        // Night 0: the pack kills the only seer; the cupid's pair is elsewhere, so the
        // seer is the only death.
        const firstNight = await playNight(game, 0, {
            lovers: [cupid, villager],
            wolfTarget: seer,
        });
        expect(firstNight.sequence).toContain(Role.SEER);
        await skipSheriffElection(game);
        expect(
            game.manager.state!.players.find((p) => p.playerUUID === seer.playerUUID)?.isAlive,
            'the seer is a corpse before night 2',
        ).toBe(false);
        await passDay(game);

        // Night 2: the dead seer must not wake, and the witch (the last role) must still
        // be able to close the night without a GM skip.
        expect(nightOrderFor(game, 1)).toEqual([Role.WEREWOLF, Role.WITCH]);
        const secondNight = await playNight(game, 1, { wolfTarget: villager });
        expect(secondNight.sequence).toEqual([Role.WEREWOLF, Role.WITCH]);
        expect(secondNight.sequence, 'a dead role never wakes').not.toContain(Role.SEER);
        expect(secondNight.dawn).toBe(Phase.DAY);

        // Across the whole game the seer turn was scheduled exactly once: on night 1.
        const seerOnsets = game.manager.history.filter(
            (s, index, history) =>
                s.phase === Phase.NIGHT &&
                s.activeNightRole === Role.SEER &&
                history[index - 1]?.activeNightRole !== Role.SEER,
        );
        expect(seerOnsets, 'a dead seer is never scheduled again').toHaveLength(1);
        game.expectNoErrors();
    });
});

describe('cupid', () => {
    it('7. a cross-team couple: lynching the wolf kills the villager lover too', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart({
            [Role.WEREWOLF]: 2,
            [Role.CUPID]: 1,
            [Role.SEER]: 1,
            [Role.VILLAGER]: 2,
        });
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const villagers = game.clientsWithRole(Role.VILLAGER);
        const seer = only(game, Role.SEER);
        const wolfLover = wolves[0]!;
        const villageLover = villagers[0]!;

        await playNight(game, 0, { lovers: [wolfLover, villageLover], wolfTarget: seer });
        await skipSheriffElection(game);
        await lynch(game, wolfLover);

        // The chain killed the villager even though nobody voted for them.
        for (const client of game.clients) {
            const state = client.state!;
            expect(deadUUIDs(state), `${client.playerUUID} death list`).toEqual(
                [seer.playerUUID, wolfLover.playerUUID, villageLover.playerUUID].sort(),
            );
            expect(state.votedOutUUID, 'only the wolf was voted out').toBe(wolfLover.playerUUID);
            expect(
                state.players.find((p) => p.playerUUID === villageLover.playerUUID)?.role,
                'the chained lover role is revealed',
            ).toBe(Role.VILLAGER);
            expect(
                state.players.find((p) => p.playerUUID === wolfLover.playerUUID)?.role,
            ).toBe(Role.WEREWOLF);
        }
        expect(game.aliveClients()).toHaveLength(3);
        expect(game.manager.state?.phase, 'one wolf still lives').toBe(Phase.DAY);
        game.expectNoErrors();
    });

    it('8. two lovers killed on the same night die exactly once each', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart({
            [Role.WEREWOLF]: 2,
            [Role.CUPID]: 1,
            [Role.WITCH]: 1,
            [Role.SEER]: 1,
            [Role.VILLAGER]: 1,
        });
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const seer = only(game, Role.SEER);
        const villager = only(game, Role.VILLAGER);
        const witch = only(game, Role.WITCH);

        // The pack bites the seer, the witch poisons the villager, and both are lovers.
        const run = await playNight(game, 0, {
            lovers: [seer, villager],
            wolfTarget: seer,
            seerTarget: wolves[0]!,
            witch: { kill: villager },
        });

        expect(run.dawn).toBe(Phase.SHERIFF_ELECTION);
        expect(deadUUIDs(game.manager.state!), 'both lovers, nobody else').toEqual(
            [seer.playerUUID, villager.playerUUID].sort(),
        );
        expect(game.aliveClients()).toHaveLength(4);
        expect(witch.state?.witchUsedKillingPotion).toBe(true);
        expect(witch.state?.witchUsedHealingPotion).toBe(false);
        game.expectNoErrors();
    });

    it('9. a lover killed at night takes the partner with them and the partner role is revealed', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart({
            [Role.WEREWOLF]: 2,
            [Role.CUPID]: 1,
            [Role.SEER]: 1,
            [Role.VILLAGER]: 2,
        });
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const villagers = game.clientsWithRole(Role.VILLAGER);
        const seer = only(game, Role.SEER);
        const victim = villagers[0]!;

        const run = await playNight(game, 0, { lovers: [seer, victim], wolfTarget: victim });
        expect(run.werewolfVictim, 'only the villager was ordered dead').toBe(victim.playerUUID);

        for (const client of game.clients) {
            const state = client.state!;
            expect(deadUUIDs(state), `${client.playerUUID} death list`).toEqual(
                [seer.playerUUID, victim.playerUUID].sort(),
            );
            // The chained partner never appeared in a wolf vote, but their role is public.
            expect(
                state.players.find((p) => p.playerUUID === seer.playerUUID)?.role,
                `${client.playerUUID} sees the chained seer role`,
            ).toBe(Role.SEER);
        }
        expect(game.aliveClients()).toHaveLength(4);
        game.expectNoErrors();
    });

    it('10. the bond survives into the next night but can never be confirmed outside the cupid turn', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_WITH_CUPID);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const seer = only(game, Role.SEER);
        const villager = only(game, Role.VILLAGER);
        const witch = only(game, Role.WITCH);

        // A heal keeps everybody alive, so both lovers walk into night 2.
        await playNight(game, 0, {
            lovers: [seer, villager],
            wolfTarget: villager,
            seerTarget: wolves[0]!,
            witch: { heal: true },
        });
        await skipSheriffElection(game);
        await passDay(game);
        await Promise.all(game.clients.map((c) => c.waitForTurn(Role.WEREWOLF)));

        // Both lovers still know each other: the bond is not cleared at dawn.
        expect(seer.state?.lovePartnerUUID).toBe(villager.playerUUID);
        expect(villager.state?.lovePartnerUUID).toBe(seer.playerUUID);
        expect(seer.state?.lovePartnerConfirmed, 'the night-0 confirmation persists').toBe(true);

        // The cupid only ever wakes on the first night, so there is no legal confirm anymore.
        // (A "only one lover is alive" confirm is unreachable: both lovers always die together
        // and the cupid phase never returns. This is the closest legal state to it.)
        const message = await rejection(
            seer,
            'confirmLoverBond',
            { gameId: game.gameId },
            'lover confirms outside the cupid turn',
        );
        expect(message).toMatch(/not CUPID/i);
        expect(seer.errors).toHaveLength(1);
        expect(seer.state?.lovePartnerUUID, 'the rejected confirm changed the bond').toBe(villager.playerUUID);

        // The night still completes normally.
        await playNight(game, 1, { wolfTarget: witch, seerTarget: wolves[0]! });
        expect(game.manager.state?.phase).toBe(Phase.DAY);
        expect(game.clients.filter((c) => c !== seer).every((c) => c.errors.length === 0)).toBe(true);
    });
});

describe('witch', () => {
    it('11. healing herself: the witch is the pack victim and survives', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_WITH_CUPID);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const seer = only(game, Role.SEER);
        const villager = only(game, Role.VILLAGER);
        const witch = only(game, Role.WITCH);

        // The rules do not forbid self-healing, and the code allows it.
        const run = await playNight(game, 0, {
            lovers: [seer, villager],
            wolfTarget: witch,
            seerTarget: wolves[0]!,
            witch: { heal: true },
        });

        expect(run.werewolfVictim, 'the witch is shown herself as the victim').toBe(witch.playerUUID);
        expect(run.dawn).toBe(Phase.SHERIFF_ELECTION);
        expect(deadUUIDs(game.manager.state!), 'the heal saved her').toEqual([]);
        expect(witch.state?.witchUsedHealingPotion).toBe(true);
        expect(game.aliveClients()).toHaveLength(6);
        game.expectNoErrors();
    });

    it('12. poisoning the player the pack is killing produces exactly one death', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_WITH_CUPID);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const seer = only(game, Role.SEER);
        const cupid = only(game, Role.CUPID);
        const villager = only(game, Role.VILLAGER);
        const witch = only(game, Role.WITCH);

        const run = await playNight(game, 0, {
            lovers: [seer, cupid],
            wolfTarget: villager,
            seerTarget: wolves[0]!,
            witch: { kill: villager },
        });

        expect(run.werewolfVictim).toBe(villager.playerUUID);
        expect(deadUUIDs(game.manager.state!), 'the double-target dies once, not twice').toEqual([
            villager.playerUUID,
        ]);
        expect(game.aliveClients()).toHaveLength(5);
        expect(witch.state?.witchUsedKillingPotion).toBe(true);
        expect(witch.state?.witchUsedHealingPotion).toBe(false);
        game.expectNoErrors();
    });

    it('13. both potions spent: the next night kill lands and nothing comes back', async () => {
        game = await TestGame.create({ playerCount: 7 });
        await game.setupAndStart(SEVEN_POTION_CHAIN);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const villagers = game.clientsWithRole(Role.VILLAGER);
        const seer = only(game, Role.SEER);
        const witch = only(game, Role.WITCH);
        const survivingVillager = villagers[0]!;

        // Night 0: heal the bitten villager, poison the seer. Both potions are gone.
        await playNight(game, 0, {
            lovers: [villagers[0]!, villagers[1]!],
            wolfTarget: villagers[0]!,
            seerTarget: wolves[0]!,
            witch: { heal: true, kill: seer },
        });
        await skipSheriffElection(game);
        expect(deadUUIDs(game.manager.state!)).toEqual([seer.playerUUID]);
        await passDay(game);

        // Night 1: the pack bites the same villager. The heal is rejected and stays spent.
        // The seer died on night 1, so it is no longer part of the order.
        const run = await playNight(game, 1, {
            wolfTarget: survivingVillager,
            witch: { heal: true, expectError: /already used healing potion/i },
        });

        expect(run.order).toEqual([Role.WEREWOLF, Role.WITCH]);
        expect(run.dawn).toBe(Phase.DAY);
        expect(witch.state?.witchUsedHealingPotion, 'potions never come back').toBe(true);
        expect(witch.state?.witchUsedKillingPotion).toBe(true);
        expect(deadUUIDs(game.manager.state!), 'the villager and their chained lover died').toEqual(
            [seer.playerUUID, villagers[0]!.playerUUID, villagers[1]!.playerUUID].sort(),
        );
        const healIndex = witch.history.findIndex((s) => s.witchUsedHealingPotion);
        expect(healIndex, 'the heal was recorded on night 1').toBeGreaterThanOrEqual(0);
        for (const state of witch.history.slice(healIndex)) {
            expect(state.witchUsedHealingPotion, 'the healing potion came back').toBe(true);
        }
        // The night-1 heal was the one deliberate rejection.
        expect(witch.errors).toHaveLength(1);
        expect(game.clients.filter((c) => c !== witch).every((c) => c.errors.length === 0)).toBe(true);
    });

    it('14. a split pack vote gives nothing to heal: the potion is not burned (B28)', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_WITH_CUPID);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const seer = only(game, Role.SEER);
        const villager = only(game, Role.VILLAGER);
        const witch = only(game, Role.WITCH);

        // One wolf on each target: no majority, so no victim.
        const run = await playNight(game, 0, {
            lovers: [seer, villager],
            wolfVotes: [seer, villager],
            seerTarget: wolves[0]!,
            witch: { heal: true, expectError: /no werewolf victim/i },
        });

        expect(run.werewolfVictim, 'a split pack has no victim').toBeNull();
        expect(deadUUIDs(game.manager.state!), 'nobody died at dawn').toEqual([]);
        expect(run.dawn, 'the night still advanced to the sheriff election').toBe(Phase.SHERIFF_ELECTION);
        expect(witch.state?.witchUsedHealingPotion, 'the rejected heal must not burn the potion').toBe(false);
        expect(witch.state?.witchUsedKillingPotion).toBe(false);
        expect(witch.errors, 'exactly the deliberate rejection').toHaveLength(1);
        expect(game.clients.filter((c) => c !== witch).every((c) => c.errors.length === 0)).toBe(true);
    });
});

describe('seer', () => {
    it('15. revealing a player who dies the same night keeps the secret for the night only', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_WITH_CUPID);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const seer = only(game, Role.SEER);
        const cupid = only(game, Role.CUPID);
        const villager = only(game, Role.VILLAGER);

        const run = await playNight(game, 0, {
            lovers: [cupid, seer],
            wolfTarget: villager,
            seerTarget: villager,
        });

        expect(run.seerRevealUUID).toBe(villager.playerUUID);
        expect(run.seerRevealRole).toBe(Role.VILLAGER);
        await skipSheriffElection(game);

        // Night actions are cleared at dawn, so the reveal itself is gone...
        expect(seer.state?.seerRevealUUID, 'the reveal is a night-only field').toBeNull();
        expect(seer.state?.seerRevealRole).toBeNull();
        // ...but the corpse role is now public to everyone.
        for (const client of game.clients) {
            expect(
                client.state?.players.find((p) => p.playerUUID === villager.playerUUID)?.role,
                `${client.playerUUID} sees the dead villager`,
            ).toBe(Role.VILLAGER);
        }
        expect(seer.state?.seerRevealRole === Role.WEREWOLF).toBe(false);
        game.expectNoErrors();
    });

    it('16. revealing a werewolf shows the role in the seer snapshot only', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_WITH_CUPID);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const seer = only(game, Role.SEER);
        const cupid = only(game, Role.CUPID);
        const villager = only(game, Role.VILLAGER);
        const revealedWolf = wolves[1]!;

        const run = await playNight(game, 0, {
            lovers: [cupid, villager],
            wolfTarget: villager,
            seerTarget: revealedWolf,
            witch: { heal: true },
        });

        expect(run.seerRevealRole).toBe(Role.WEREWOLF);
        expect(run.seerRevealUUID).toBe(revealedWolf.playerUUID);

        // The reveal never lands in anyone else's snapshot, not even the other wolf's.
        for (const client of game.clients) {
            if (client === seer) continue;
            for (const state of client.history) {
                expect(state.seerRevealUUID, `${client.playerUUID} saw a reveal`).toBeNull();
                expect(state.seerRevealRole, `${client.playerUUID} saw a revealed role`).toBeNull();
            }
        }
        // A living role is still hidden in the public player list, including the revealed wolf.
        eachSnapshot(game.clients, (s) => s.phase === Phase.NIGHT, (s, where) => {
            for (const living of s.players.filter((p) => p.isAlive)) {
                expect(living.role, `${where} leaks a living role`).toBeNull();
            }
        });
        game.expectNoErrors();
    });
});

describe('werewolves', () => {
    it('17. a wolf cannot vote for itself, and a second wolf completes the kill', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(NO_CUPID_NO_WITCH);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const villagers = game.clientsWithRole(Role.VILLAGER);
        const victim = villagers[0]!;
        await Promise.all(game.clients.map((c) => c.waitForTurn(Role.WEREWOLF)));

        const selfVote = await rejection(
            wolves[0]!,
            'werewolfVote',
            { gameId: game.gameId, targetUUID: wolves[0]!.playerUUID },
            'wolf votes for itself',
        );
        expect(selfVote).toMatch(/themselves/i);
        expect(wolves[0]!.state?.werewolfVotes, 'the rejected vote was not stored').toBeNull();

        // First wolf votes for the victim: one vote is recorded, no victim yet.
        wolves[0]!.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: victim.playerUUID });
        const oneVote = await wolves[0]!.waitFor(
            (s) => Object.keys(s.werewolfVotes ?? {}).length === 1,
            'first wolf vote recorded',
        );
        expect(oneVote.werewolfVictim, 'no victim with one of two votes').toBeNull();
        expect(oneVote.phase).toBe(Phase.NIGHT);
        expect(oneVote.activeNightRole).toBe(Role.WEREWOLF);

        // Second wolf, same target: the kill resolves immediately.
        wolves[1]!.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: victim.playerUUID });
        const resolved = await wolves[0]!.waitFor(
            (s) => s.phase !== Phase.NIGHT || s.activeNightRole !== Role.WEREWOLF,
            'pack vote resolved',
        );
        expect(resolved.werewolfVictim).toBe(victim.playerUUID);

        // The rest of the night: the seer confirms, then dawn.
        await Promise.all(game.clients.map((c) => c.waitForTurn(Role.SEER)));
        only(game, Role.SEER).socket.emit('seerConfirmed', { gameId: game.gameId });
        await game.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);
        expect(deadUUIDs(game.manager.state!)).toEqual([victim.playerUUID]);
        expect(wolves[0]!.errors).toHaveLength(1);
        expect(game.clients.filter((c) => c !== wolves[0]).every((c) => c.errors.length === 0)).toBe(true);
    });

    it('18. a two-wolf pack: a vote for a packmate is rejected, a normal vote kills', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(NO_CUPID_NO_WITCH);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const villagers = game.clientsWithRole(Role.VILLAGER);
        const victim = villagers[0]!;
        await Promise.all(game.clients.map((c) => c.waitForTurn(Role.WEREWOLF)));

        // The pack hunts villagers, not each other: same rejection shape as a self-vote.
        const packVote = await rejection(
            wolves[0]!,
            'werewolfVote',
            { gameId: game.gameId, targetUUID: wolves[1]!.playerUUID },
            'wolf votes for a packmate',
        );
        expect(packVote).toMatch(/another werewolf/i);
        expect(wolves[0]!.state?.werewolfVotes, 'the rejected vote was not stored').toBeNull();
        expect(wolves[0]!.state?.activeNightRole, 'the rejected vote did not advance the turn').toBe(
            Role.WEREWOLF,
        );

        // A living non-wolf is a legal target: the first of two votes is recorded, no victim yet.
        wolves[0]!.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: victim.playerUUID });
        const oneVote = await wolves[0]!.waitFor(
            (s) => Object.keys(s.werewolfVotes ?? {}).length === 1,
            'first wolf vote recorded',
        );
        expect(oneVote.werewolfVictim, 'no victim with one of two votes').toBeNull();
        expect(oneVote.phase).toBe(Phase.NIGHT);
        expect(oneVote.activeNightRole).toBe(Role.WEREWOLF);

        // The second wolf completes the kill.
        wolves[1]!.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: victim.playerUUID });
        const resolved = await wolves[0]!.waitFor(
            (s) => s.phase !== Phase.NIGHT || s.activeNightRole !== Role.WEREWOLF,
            'pack vote resolved',
        );
        expect(resolved.werewolfVictim).toBe(victim.playerUUID);

        // The rest of the night: the seer confirms, then dawn.
        await Promise.all(game.clients.map((c) => c.waitForTurn(Role.SEER)));
        only(game, Role.SEER).socket.emit('seerConfirmed', { gameId: game.gameId });
        await game.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);
        expect(deadUUIDs(game.manager.state!)).toEqual([victim.playerUUID]);
        expect(wolves[0]!.errors, 'exactly the deliberate rejection').toHaveLength(1);
        expect(game.clients.filter((c) => c !== wolves[0]).every((c) => c.errors.length === 0)).toBe(true);
    });

    it('19. split votes leave nobody dead and the night still advances', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_WITH_CUPID);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const seer = only(game, Role.SEER);
        const cupid = only(game, Role.CUPID);
        const villager = only(game, Role.VILLAGER);

        const run = await playNight(game, 0, {
            lovers: [seer, villager],
            wolfVotes: [seer, cupid],
            seerTarget: wolves[0]!,
        });

        expect(run.werewolfVictim).toBeNull();
        expect(deadUUIDs(game.manager.state!), 'a split pack kills nobody').toEqual([]);
        expect(run.dawn).toBe(Phase.SHERIFF_ELECTION);

        // The round really incremented: the next night opens with the wolves, never the cupid.
        await skipSheriffElection(game);
        await passDay(game);
        expect(game.clients[0]!.state?.phase).toBe(Phase.NIGHT);
        expect(game.clients[0]!.state?.activeNightRole, 'the cupid must not be scheduled again').toBe(
            Role.WEREWOLF,
        );
        for (const client of game.clients) {
            expect(client.state?.activeNightRole, `${client.playerUUID} night 2 turn`).toBe(Role.WEREWOLF);
        }
        game.expectNoErrors();
    });

    it('20. the whole pack dying at dawn through the lover chain ends the game as a village win', async () => {
        game = await TestGame.create({ playerCount: 5 });
        await game.setupAndStart(FIVE_ALL_WOLVES_DIE);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const villager = only(game, Role.VILLAGER);
        const cupid = only(game, Role.CUPID);
        const witch = only(game, Role.WITCH);

        // The two wolves are each other's lovers: poisoning one takes the other down.
        const run = await playNight(game, 0, {
            lovers: [wolves[0]!, wolves[1]!],
            wolfTarget: villager,
            witch: { kill: wolves[0]! },
        });

        expect(run.dawn, 'no wolves left at dawn').toBe(Phase.GAME_OVER);
        for (const client of game.clients) {
            const state = client.state!;
            expect(state.phase, `${client.playerUUID} phase`).toBe(Phase.GAME_OVER);
            expect(state.winningTeam, `${client.playerUUID} winning team`).toBe('village');
            expect(
                state.players.filter((p) => p.isAlive).map((p) => p.playerUUID).sort(),
                'only the cupid and the witch survive',
            ).toEqual([cupid.playerUUID, witch.playerUUID].sort());
            expect(
                state.players.filter((p) => !p.isAlive).map((p) => p.playerUUID).sort(),
                'the villager and both chained wolves are dead',
            ).toEqual([villager.playerUUID, wolves[0]!.playerUUID, wolves[1]!.playerUUID].sort());
            for (const player of state.players) {
                expect(player.role, 'GAME_OVER reveals every role').not.toBeNull();
            }
        }
        game.expectNoErrors();
    });
});

describe('red lady', () => {
    it('21. visiting a werewolf who is not tonight\'s victim changes nothing', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_RED_LADY);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const villagers = game.clientsWithRole(Role.VILLAGER);
        const redLady = only(game, Role.RED_LADY);
        const victim = villagers[0]!;

        const run = await playNight(game, 0, {
            redLady: { target: wolves[0]! },
            wolfTarget: victim,
        });

        // shared/roles.ts: she dies only when her host is attacked that night.
        expect(run.redLadySleepoverUUID).toBe(wolves[0]!.playerUUID);
        expect(deadUUIDs(game.manager.state!), 'the red lady survives an un-attacked host').toEqual([
            victim.playerUUID,
        ]);
        expect(
            game.manager.state!.players.find((p) => p.playerUUID === redLady.playerUUID)?.isAlive,
            'the red lady is alive',
        ).toBe(true);
        for (const client of game.clients.filter((c) => c !== redLady)) {
            expect(client.state?.redLadySleepoverUUID, `${client.playerUUID} sees the host`).toBeNull();
        }
        game.expectNoErrors();
    });

    it('22. sleeping over at her own place is rejected and the night continues', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_RED_LADY);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const villagers = game.clientsWithRole(Role.VILLAGER);
        const redLady = only(game, Role.RED_LADY);

        const run = await playNight(game, 0, {
            redLady: { target: redLady, expectError: /own place/i, retry: villagers[0]! },
            wolfTarget: villagers[1]!,
        });

        expect(run.redLadySleepoverUUID, 'the legal retry replaced the rejected self-visit').toBe(
            villagers[0]!.playerUUID,
        );
        expect(run.sequence).toEqual([Role.RED_LADY, Role.WEREWOLF]);
        expect(deadUUIDs(game.manager.state!), 'the red lady did not die without a host').toEqual([
            villagers[1]!.playerUUID,
        ]);
        expect(redLady.errors).toHaveLength(1);
        expect(game.clients.filter((c) => c !== redLady).every((c) => c.errors.length === 0)).toBe(true);
    });

    it('23. sleeping over at a corpse is rejected on a later night', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_RED_LADY);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const villagers = game.clientsWithRole(Role.VILLAGER);
        const redLady = only(game, Role.RED_LADY);
        const corpse = villagers[0]!;

        await playNight(game, 0, { redLady: { target: wolves[0]! }, wolfTarget: corpse });
        await skipSheriffElection(game);
        expect(deadUUIDs(game.manager.state!)).toEqual([corpse.playerUUID]);
        await passDay(game);

        const run = await playNight(game, 1, {
            redLady: { target: corpse, expectError: /already dead/i, retry: wolves[0]! },
            wolfTarget: villagers[1]!,
        });

        expect(run.redLadySleepoverUUID, 'the living host was recorded instead').toBe(wolves[0]!.playerUUID);
        expect(deadUUIDs(game.manager.state!), 'deaths accumulate').toEqual(
            [corpse.playerUUID, villagers[1]!.playerUUID].sort(),
        );
        expect(run.dawn).toBe(Phase.DAY);
        expect(redLady.errors).toHaveLength(1);
        expect(game.clients.filter((c) => c !== redLady).every((c) => c.errors.length === 0)).toBe(true);
    });
});

describe('repeated rounds', () => {
    it('24. three nights: potions never return, the cupid only wakes once, deaths only grow', async () => {
        game = await TestGame.create({ playerCount: 7 });
        await game.setupAndStart(SEVEN_POTION_CHAIN);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const villagers = game.clientsWithRole(Role.VILLAGER);
        const seer = only(game, Role.SEER);
        const witch = only(game, Role.WITCH);
        const cupid = only(game, Role.CUPID);

        // Night 1 (round 0): everybody survives the heal, so the game can run for three nights.
        const night0 = await playNight(game, 0, {
            lovers: [seer, villagers[0]!],
            wolfTarget: villagers[1]!,
            seerTarget: wolves[0]!,
            witch: { heal: true },
        });
        expect(night0.dawn).toBe(Phase.SHERIFF_ELECTION);
        expect(deadUUIDs(game.manager.state!)).toEqual([]);
        await skipSheriffElection(game);
        await passDay(game);

        // Night 2 (round 1): no cupid, a real death.
        const night1 = await playNight(game, 1, { wolfTarget: villagers[1]!, seerTarget: wolves[0]! });
        expect(night1.sequence).toEqual([Role.WEREWOLF, Role.SEER, Role.WITCH]);
        expect(night1.dawn).toBe(Phase.DAY);
        expect(deadUUIDs(game.manager.state!)).toEqual([villagers[1]!.playerUUID]);
        await passDay(game);

        // Night 3 (round 2): still no cupid, the second death.
        const night2 = await playNight(game, 2, { wolfTarget: cupid, seerTarget: wolves[0]! });
        expect(night2.sequence).toEqual([Role.WEREWOLF, Role.SEER, Role.WITCH]);
        expect(night2.dawn).toBe(Phase.DAY);
        expect(deadUUIDs(game.manager.state!)).toEqual([villagers[1]!.playerUUID, cupid.playerUUID].sort());

        // The round counter is not part of the snapshot (B48), so it is asserted through its
        // only observable consequences: exactly one election night, no cupid after round 0.
        const cupidOnsets = game.manager.history.filter(
            (s, index, history) =>
                s.phase === Phase.NIGHT &&
                s.activeNightRole === Role.CUPID &&
                history[index - 1]?.activeNightRole !== Role.CUPID,
        );
        expect(cupidOnsets, 'cupid wakes exactly once in three nights').toHaveLength(1);
        expect(witch.history.filter((s) => s.witchUsedKillingPotion), 'the kill potion was never used').toEqual([]);
        // From the heal on, the healing potion is spent in every snapshot, forever.
        const healIndex = witch.history.findIndex((s) => s.witchUsedHealingPotion);
        expect(healIndex, 'the heal was recorded on night 1').toBeGreaterThanOrEqual(0);
        for (const state of witch.history.slice(healIndex)) {
            expect(state.witchUsedHealingPotion, 'the healing potion came back').toBe(true);
        }
        for (const client of game.clients) expectDeathsMonotonic(client);
        expect(game.aliveClients()).toHaveLength(5);
        game.expectNoErrors();
    });
});

describe('little girl', () => {
    it('25. LITTLE_GIRL never wakes and the night resolves without her', async () => {
        // The role is declared but not implemented: no night action, no route, and
        // `wakesUp: false` keeps it out of every night order.
        expect(ROLES[Role.LITTLE_GIRL].wakesUp).toBe(false);
        expect(ROLES[Role.LITTLE_GIRL].nightOrder).toBeLessThan(0);

        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_WITH_LITTLE_GIRL);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const villagers = game.clientsWithRole(Role.VILLAGER);
        const littleGirl = only(game, Role.LITTLE_GIRL);
        expect(littleGirl.state?.role).toBe(Role.LITTLE_GIRL);

        const run = await playNight(game, 0, { wolfTarget: villagers[0]!, seerTarget: wolves[0]! });
        expect(run.order, 'the little girl is not in the night order').toEqual([Role.WEREWOLF, Role.SEER]);
        expect(run.sequence).toEqual([Role.WEREWOLF, Role.SEER]);

        // No phone is ever told that a little girl turn exists.
        eachSnapshot(game.clients, (s) => s.phase === Phase.NIGHT, (s, where) => {
            expect(s.activeNightRole, `${where} scheduled the little girl`).not.toBe(Role.LITTLE_GIRL);
        });
        // And she has no private night field of her own.
        expect(littleGirl.state?.seerRevealUUID).toBeNull();
        expect(littleGirl.state?.redLadySleepoverUUID).toBeNull();
        expect(littleGirl.state?.werewolfVotes).toBeNull();
        expect(littleGirl.state?.werewolfVictim).toBeNull();
        expect(deadUUIDs(game.manager.state!)).toEqual([villagers[0]!.playerUUID]);
        game.expectNoErrors();
    });
});

// Two rules that this file first exposed as broken and that are now fixed in the app. They
// live together here as regression pins: a packmate vote is rejected, and a poisoned red lady
// dies while an attacked one still survives.
describe('pack immunity and red lady poison', () => {
    it('26. the witch poison kills the red lady, but she still escapes a werewolf attack on her', async () => {
        game = await TestGame.create({ playerCount: 7 });
        await game.setupAndStart({
            [Role.WEREWOLF]: 2,
            [Role.WITCH]: 1,
            [Role.RED_LADY]: 1,
            [Role.VILLAGER]: 3,
        });
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const villagers = game.clientsWithRole(Role.VILLAGER);
        const redLady = only(game, Role.RED_LADY);
        const witch = only(game, Role.WITCH);
        const victim = villagers[0]!;

        // She is visiting a wolf whose host is not attacked, so only the poison can be aimed at
        // her: the potion must do what the witch was promised and kill her.
        const run = await playNight(game, 0, {
            redLady: { target: wolves[0]! },
            wolfTarget: victim,
            witch: { kill: redLady },
        });

        expect(run.werewolfVictim).toBe(victim.playerUUID);
        expect(deadUUIDs(game.manager.state!), 'the pack victim and the poisoned red lady died').toEqual(
            [victim.playerUUID, redLady.playerUUID].sort(),
        );
        expect(
            game.manager.state!.players.find((p) => p.playerUUID === redLady.playerUUID)?.isAlive,
            'a direct poison kills the red lady',
        ).toBe(false);
        expect(
            game.manager.state!.players.find((p) => p.playerUUID === redLady.playerUUID)?.role,
            'the dead red lady role is public',
        ).toBe(Role.RED_LADY);
        expect(witch.state?.witchUsedKillingPotion, 'the potion is still spent').toBe(true);
        expect(witch.state?.witchUsedHealingPotion).toBe(false);
        game.expectNoErrors();

        // The immunity she does have stays intact: an attack aimed at HER is survived.
        await game.close();
        game = await TestGame.create({ playerCount: 7 });
        await game.setupAndStart({
            [Role.WEREWOLF]: 2,
            [Role.WITCH]: 1,
            [Role.RED_LADY]: 1,
            [Role.VILLAGER]: 3,
        });
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves2 = game.clientsWithRole(Role.WEREWOLF);
        const redLady2 = only(game, Role.RED_LADY);
        const attack = await playNight(game, 0, {
            redLady: { target: wolves2[0]! },
            wolfTarget: redLady2,
        });

        expect(attack.werewolfVictim, 'the pack really aimed at her').toBe(redLady2.playerUUID);
        expect(deadUUIDs(game.manager.state!), 'she survives an attack aimed at her').toEqual([]);
        expect(
            game.manager.state!.players.find((p) => p.playerUUID === redLady2.playerUUID)?.isAlive,
            'the attacked red lady lives',
        ).toBe(true);
        game.expectNoErrors();
    });

    it('27. a three-wolf pack cannot eliminate its own member: the packmate vote is rejected', async () => {
        game = await TestGame.create({ playerCount: 10 });
        await game.setupAndStart({
            [Role.WEREWOLF]: 3,
            [Role.SEER]: 1,
            [Role.VILLAGER]: 6,
        });
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const villagers = game.clientsWithRole(Role.VILLAGER);
        expect(wolves).toHaveLength(3);
        const victim = villagers[0]!;
        await Promise.all(game.clients.map((c) => c.waitForTurn(Role.WEREWOLF)));

        // The exact sequence that used to kill a wolf: A -> C, B -> C, C -> villager (2:1).
        // The first vote for a packmate is now rejected, so no majority on a wolf can exist.
        const packVote = await rejection(
            wolves[0]!,
            'werewolfVote',
            { gameId: game.gameId, targetUUID: wolves[2]!.playerUUID },
            'wolf A votes for wolf C',
        );
        expect(packVote).toMatch(/another werewolf/i);
        expect(wolves[0]!.state?.werewolfVotes, 'the rejected vote was not stored').toBeNull();

        // A unanimous pack vote on a villager still resolves normally.
        const run = await playNight(game, 0, {
            wolfVotes: [victim, victim, victim],
            seerTarget: wolves[0]!,
        });

        expect(run.werewolfVictim, 'the pack victim is the villager').toBe(victim.playerUUID);
        const dead = deadUUIDs(game.manager.state!);
        expect(dead, 'only the ordered villager died').toEqual([victim.playerUUID]);
        expect(dead, 'no werewolf can ever be the pack victim').not.toContain(wolves[2]!.playerUUID);
        expect(run.sequence).toEqual([Role.WEREWOLF, Role.SEER]);
        expect(wolves[0]!.errors, 'exactly the deliberate rejection').toHaveLength(1);
        expect(game.clients.filter((c) => c !== wolves[0]).every((c) => c.errors.length === 0)).toBe(true);
    });
});
