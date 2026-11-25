// Property-based (fuzz) end-to-end games over the real socket contract.
//
// A seeded random driver plays a whole game: random player count (4-10), random valid role
// composition, and for every step one client picks the next legal action from its own
// tailored snapshot. After every sync the invariants in `fuzz/invariants.ts` are checked.
//
// Every run prints its seed, so a red CI run tells you exactly what to re-run:
//   E2E_SEED=<seed> E2E_FUZZ_GAMES=<n> npx vitest run src/__tests__/e2e/fuzz.test.ts
//
// The role deal is seeded too: `Math.random` is replaced for the single `roleDistribution`
// call with an rng derived from the same seed, so a run replays all the way down to who is
// the seer. No `managerAdvance` is ever used: a random game that needs the AFK escape hatch
// is a bug and fails.

import { describe, it, expect, afterEach } from 'vitest';
import { TestGame } from './harness.js';
import type { Client, Snapshot } from './harness.js';
import { Phase } from '@shared/phases.js';
import { Role } from '@shared/roles.js';
import { makeRng, resolveSeed, deriveSeed } from './fuzz/prng.js';
import type { Rng } from './fuzz/prng.js';
import {
    CHAOS_PROBABILITY,
    chooseAction,
    chooseChaosAction,
    newPolicyMemory,
    planRun,
} from './fuzz/policy.js';
import type { Action, ActionKind, ActionRecord, PolicyContext, RunPlan } from './fuzz/policy.js';
import { InvariantChecker } from './fuzz/invariants.js';

const MAX_EVENTS = 3000;
const MAX_ROUNDS = 30;

function gameCountFromEnv(): number {
    const raw = process.env.E2E_FUZZ_GAMES;
    if (raw === undefined || raw.trim() === '') return 3;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`E2E_FUZZ_GAMES must be an integer >= 0, got ${JSON.stringify(raw)}`);
    }
    return parsed;
}

const GAME_COUNT = gameCountFromEnv();
const SEED_INFO = resolveSeed();

interface GameSummary {
    seed: number;
    playerCount: number;
    composition: string;
    rounds: number;
    events: number;
    uniqueStates: number;
    winner: string;
    branches: string[];
}

interface GameResult {
    summary: GameSummary;
    stateKeys: Set<string>;
    pairs: Set<string>;
    phases: Set<Phase>;
    branches: Set<string>;
}

const report = {
    games: [] as GameSummary[],
    stateKeys: new Set<string>(),
    pairs: new Set<string>(),
    phases: new Set<Phase>(),
    /** branch -> number of distinct games in which it was observed */
    branchGames: new Map<string, number>(),
    gamesPastFirstDawn: 0,
};

let game: TestGame | null = null;

afterEach(async () => {
    await game?.close();
    game = null;
});

// --- helpers ---------------------------------------------------------------

function currentSnapshot(target: TestGame): Snapshot {
    const snapshot = target.clients[0]?.state;
    if (!snapshot) throw new Error('the first client has no snapshot yet');
    return snapshot;
}

/** True roles by playerUUID, reconstructed from each client's own snapshot (never from others). */
function oracleRoles(target: TestGame): Map<string, Role> {
    const roles = new Map<string, Role>();
    for (const client of target.clients) {
        if (client.playerUUID && client.state?.role) roles.set(client.playerUUID, client.state.role as Role);
    }
    return roles;
}

function stateKey(snapshot: Snapshot, round: number, roles: Map<string, Role>): string {
    const aliveRoles = snapshot.players
        .filter((p) => p.isAlive)
        .map((p) => roles.get(p.playerUUID) ?? '?')
        .sort()
        .join('+');
    return [
        snapshot.phase,
        `r${round}`,
        snapshot.activeNightRole ?? 'no-role',
        aliveRoles,
        snapshot.players.some((p) => p.isSheriff) ? 'sheriff' : 'no-sheriff',
        snapshot.lynchDone ? 'lynched' : 'lynch-open',
        snapshot.sheriffElectionDone ? 'election-done' : 'election-open',
        snapshot.winningTeam ?? '-',
    ].join('|');
}

/** Hard branches observable in a snapshot. Used to prove they were actually reached. */
function detectBranches(snapshot: Snapshot, nightsStarted: number): string[] {
    const found: string[] = [];

    if (snapshot.phase === Phase.DAY && snapshot.lynchDone && snapshot.votedOutUUID === null) {
        const hasNominees = snapshot.players.some((p) => typeof p.nomination === 'string');
        if (!hasNominees) {
            found.push('all-abstain');
        } else if (snapshot.voteResults) {
            const counts = new Map<string, number>();
            for (const target of Object.values(snapshot.voteResults)) {
                if (typeof target === 'string') counts.set(target, (counts.get(target) ?? 0) + 1);
            }
            if (counts.size >= 2) {
                const values = [...counts.values()];
                const max = Math.max(...values);
                if (values.filter((count) => count === max).length >= 2) found.push('tie');
            }
        }
    }

    if (snapshot.sheriffElectionDone && !snapshot.players.some((p) => p.isSheriff)) {
        found.push('no-sheriff');
    }
    if (snapshot.witchUsedHealingPotion && snapshot.witchUsedKillingPotion) {
        found.push('witch-spent');
    }
    if (snapshot.phase === Phase.GAME_OVER && snapshot.winningTeam === 'village' && nightsStarted === 1) {
        found.push('early-village-win');
    }

    return found;
}

interface ChosenAction {
    client: Client;
    action: Action;
}

function findAction(
    order: Client[],
    kind: ActionKind,
    rng: Rng,
    ctx: PolicyContext,
): ChosenAction | null {
    for (const client of order) {
        const snapshot = client.state;
        if (!snapshot) continue;
        const action = kind === 'legal'
            ? chooseAction(client, snapshot, rng, ctx)
            : chooseChaosAction(client, snapshot, rng, ctx);
        if (action) return { client, action };
    }
    return null;
}

type Outcome = 'sync' | 'error' | 'timeout';

/**
 * Emits one action and resolves with the first reaction of that client: a new snapshot (accepted)
 * or an error (rejected). For `roleDistribution` the global `Math.random` is replaced while the
 * server handler runs, which makes the role deal replayable from the seed.
 */
function emitAndAwait(client: Client, action: Action, mathRandomSeed: number | null): Promise<Outcome> {
    return new Promise<Outcome>((resolve) => {
        let settled = false;
        let originalRandom: (() => number) | null = null;

        const finish = (outcome: Outcome): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            client.socket.off('syncState', onSync);
            client.socket.off('error', onError);
            if (originalRandom) Math.random = originalRandom;
            resolve(outcome);
        };

        const onSync = (): void => finish('sync');
        const onError = (): void => finish('error');
        const timer = setTimeout(() => finish('timeout'), 8000);

        client.socket.on('syncState', onSync);
        client.socket.on('error', onError);

        if (mathRandomSeed !== null) {
            originalRandom = Math.random;
            const seeded = makeRng(deriveSeed(mathRandomSeed, 0, 0x5151));
            Math.random = () => seeded.next();
        }

        client.socket.emit(action.event, action.payload);
    });
}

async function waitForAllSynced(target: TestGame, before: Map<Client, number>): Promise<void> {
    await Promise.all(
        target.clients.map((client) =>
            client.waitFor(
                () => client.history.length > (before.get(client) ?? 0),
                'sync after fuzz action',
                8000,
            ),
        ),
    );
}

/**
 * Executes one action. A rejected legal action is a bug and fails the run; a rejected chaos
 * action is expected. An accepted chaos action is fine too.
 */
async function execute(
    target: TestGame,
    client: Client,
    action: Action,
    seed: number,
): Promise<void> {
    const before = new Map(target.clients.map((c) => [c, c.history.length] as const));
    const outcome = await emitAndAwait(
        client,
        action,
        action.event === 'roleDistribution' ? seed : null,
    );

    if (action.kind === 'legal') {
        if (outcome !== 'sync') {
            const detail = client.errors.length > 0 ? client.errors.join(' | ') : 'no error message';
            throw new Error(
                `${outcome === 'error' ? 'REJECTED LEGAL ACTION' : 'NO ANSWER TO LEGAL ACTION'}: ` +
                    `${action.event} ${JSON.stringify(action.payload)} -- ${detail}`,
            );
        }
        await waitForAllSynced(target, before);
        return;
    }

    if (outcome === 'sync') {
        await waitForAllSynced(target, before);
    } else if (outcome !== 'error') {
        throw new Error(`NO ANSWER TO CHAOS ACTION: ${action.event} ${JSON.stringify(action.payload)}`);
    }
}

function buildDiagnostic(args: {
    seed: number;
    plan: RunPlan;
    reason: string;
    round: number;
    nightsStarted: number;
    events: number;
    actions: ActionRecord[];
    clients: Client[];
}): string {
    const lines: string[] = [];
    lines.push('=== FUZZ FAILURE ===');
    lines.push(`seed: ${args.seed}`);
    lines.push(`playerCount: ${args.plan.playerCount}`);
    lines.push(`composition: ${JSON.stringify(args.plan.composition)}`);
    lines.push(`branches planned: ${JSON.stringify(args.plan.branches)}`);
    lines.push(`round: ${args.round}  nightsStarted: ${args.nightsStarted}  events: ${args.events}`);
    lines.push(`reason: ${args.reason}`);
    lines.push(`last ${Math.min(20, args.actions.length)} actions (oldest first):`);
    for (const record of args.actions.slice(-20)) {
        lines.push(
            `  [${record.phase} r${record.round}] ${record.actor.slice(0, 8)} ${record.event} ` +
                `${JSON.stringify(record.payload)}${record.branch ? ` [branch:${record.branch}]` : ''} (${record.kind})`,
        );
    }
    lines.push('last snapshot per client:');
    for (const client of args.clients) {
        lines.push(`  ${client.playerUUID ?? '?'}: ${client.state ? JSON.stringify(client.state) : 'null'}`);
    }
    return lines.join('\n');
}

async function playGame(
    target: TestGame,
    plan: RunPlan,
    rng: Rng,
    seed: number,
): Promise<GameResult> {
    const checker = new InvariantChecker(target.clients);
    const memory = newPolicyMemory();
    const ctx: PolicyContext = {
        plan,
        memory,
        oracle: oracleRoles(target),
        managerUUID: target.clients.find((c) => c.state?.isManager)?.playerUUID ?? null,
    };

    const actions: ActionRecord[] = [];
    const stateKeys = new Set<string>();
    const pairs = new Set<string>();
    const phases = new Set<Phase>();
    const branches = new Set<string>();

    let nightsStarted = 0;
    let lastPhase: Phase | null = null;
    let events = 0;

    const observe = (snapshot: Snapshot, round: number): void => {
        phases.add(snapshot.phase);
        pairs.add(`${snapshot.phase}|${snapshot.activeNightRole ?? '-'}`);
        ctx.oracle = oracleRoles(target);
        stateKeys.add(stateKey(snapshot, round, ctx.oracle));
        for (const client of target.clients) {
            if (!client.state) continue;
            for (const branch of detectBranches(client.state, nightsStarted)) branches.add(branch);
        }
    };

    try {
        checker.check();
        observe(currentSnapshot(target), 0);

        while (true) {
            const snapshot = currentSnapshot(target);
            if (snapshot.phase !== lastPhase) {
                if (snapshot.phase === Phase.NIGHT) nightsStarted++;
                lastPhase = snapshot.phase;
            }
            const round = Math.max(0, nightsStarted - 1);
            memory.round = round;
            observe(snapshot, round);

            if (snapshot.phase === Phase.GAME_OVER) break;

            if (nightsStarted > MAX_ROUNDS) {
                throw new Error(
                    `ROUND CAP: ${nightsStarted} nights started (> ${MAX_ROUNDS}), phase=${snapshot.phase} ` +
                        `activeNightRole=${snapshot.activeNightRole ?? 'null'}`,
                );
            }
            if (events >= MAX_EVENTS) {
                throw new Error(`EVENT CAP: ${events} events (>= ${MAX_EVENTS}), phase=${snapshot.phase}`);
            }

            const order = rng.shuffle(target.clients);
            let chosen: ChosenAction | null = null;

            if (rng.bool(CHAOS_PROBABILITY)) {
                chosen = findAction(order, 'chaos', rng, ctx);
            }
            if (!chosen) {
                chosen = findAction(order, 'legal', rng, ctx);
            }
            if (!chosen) {
                throw new Error(
                    `DEADLOCK: no client has a legal action. phase=${snapshot.phase} ` +
                        `activeNightRole=${snapshot.activeNightRole ?? 'null'} round=${round} ` +
                        `living=${snapshot.players.filter((p) => p.isAlive).length}`,
                );
            }

            const record: ActionRecord = {
                round,
                phase: snapshot.phase,
                actor: chosen.client.playerUUID ?? '?',
                event: chosen.action.event,
                payload: chosen.action.payload,
                kind: chosen.action.kind,
                ...(chosen.action.branch ? { branch: chosen.action.branch } : {}),
            };
            actions.push(record);
            events++;
            if (chosen.action.branch) branches.add(chosen.action.branch);

            await execute(target, chosen.client, chosen.action, seed);

            if (record.phase === Phase.LOBBY) memory.lobbySteps++;
            checker.check();
        }

        checker.check();
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const dump = buildDiagnostic({
            seed,
            plan,
            reason,
            round: memory.round,
            nightsStarted,
            events,
            actions,
            clients: target.clients,
        });
        const stack = error instanceof Error && error.stack ? `\n${error.stack}` : '';
        throw new Error(`${dump}${stack}`);
    }

    return {
        summary: {
            seed,
            playerCount: plan.playerCount,
            composition: JSON.stringify(plan.composition),
            rounds: nightsStarted,
            events,
            uniqueStates: stateKeys.size,
            winner: currentSnapshot(target).winningTeam ?? '(none)',
            branches: [...branches].sort(),
        },
        stateKeys,
        pairs,
        phases,
        branches,
    };
}

// --- the run ---------------------------------------------------------------

describe('fuzz: seeded random games', () => {
    it(
        'plays seeded random games from lobby to GAME_OVER',
        async () => {
            console.log(
                `[fuzz] base seed=${SEED_INFO.seed} (${SEED_INFO.source}) games=${GAME_COUNT} ` +
                    `timeout=300s; re-run with E2E_SEED=${SEED_INFO.seed}`,
            );
            if (GAME_COUNT === 0) return;

            for (let index = 0; index < GAME_COUNT; index++) {
                const gameSeed = deriveSeed(SEED_INFO.seed, index);
                const rng = makeRng(gameSeed);
                const playerCount = rng.int(4, 10);
                const plan = planRun(rng, playerCount);

                console.log(
                    `[fuzz] game ${index + 1}/${GAME_COUNT} seed=${gameSeed} players=${playerCount} ` +
                        `composition=${JSON.stringify(plan.composition)} plannedBranches=` +
                        `${JSON.stringify(Object.entries(plan.branches).filter(([, on]) => on).map(([name]) => name))}`,
                );

                let created: TestGame | null = null;
                try {
                    created = await TestGame.create({ playerCount });
                    game = created;
                    const result = await playGame(created, plan, rng, gameSeed);

                    report.games.push(result.summary);
                    for (const key of result.stateKeys) report.stateKeys.add(key);
                    for (const pair of result.pairs) report.pairs.add(pair);
                    for (const phase of result.phases) report.phases.add(phase);
                    for (const branch of result.branches) {
                        report.branchGames.set(branch, (report.branchGames.get(branch) ?? 0) + 1);
                    }
                    if (result.phases.has(Phase.DAY) || result.summary.rounds >= 2) {
                        report.gamesPastFirstDawn++;
                    }

                    console.log(
                        `[fuzz] game ${index + 1} done: winner=${result.summary.winner} ` +
                            `rounds=${result.summary.rounds} events=${result.summary.events} ` +
                            `uniqueStates=${result.summary.uniqueStates} ` +
                            `branches=${result.summary.branches.join(',') || '-'}`,
                    );
                } finally {
                    await created?.close();
                    game = null;
                }
            }

            expect(report.games.length).toBe(GAME_COUNT);
        },
        300_000,
    );

    it('reports state coverage', () => {
        if (GAME_COUNT === 0) {
            console.log('[fuzz] coverage skipped: E2E_FUZZ_GAMES=0');
            return;
        }
        if (report.games.length < GAME_COUNT) {
            // The run test is already red and carries the diagnostic; coverage of an aborted
            // run group would only add noise.
            console.log(
                `[fuzz] coverage incomplete: ${report.games.length}/${GAME_COUNT} games finished; ` +
                    'see the failing run test for the seed and dump.',
            );
            return;
        }

        const branchGames = Object.fromEntries([...report.branchGames.entries()].sort());
        console.log(
            `[fuzz] coverage: total unique states=${report.stateKeys.size}, ` +
                `(phase,activeNightRole) pairs=${report.pairs.size}`,
        );
        console.log(`[fuzz] coverage pairs: ${[...report.pairs].sort().join(', ')}`);
        console.log(`[fuzz] hard branches reached (games): ${JSON.stringify(branchGames)}`);

        for (const summary of report.games) {
            console.log(
                `[fuzz] summary seed=${summary.seed} players=${summary.playerCount} ` +
                    `composition=${summary.composition} winner=${summary.winner} rounds=${summary.rounds} ` +
                    `events=${summary.events} uniqueStates=${summary.uniqueStates} ` +
                    `branches=${summary.branches.join(',') || '-'}`,
            );
        }

        const alwaysReachable = [
            Phase.LOBBY,
            Phase.ROLE_SELECTION,
            Phase.DISTRIBUTION,
            Phase.NIGHT,
            Phase.GAME_OVER,
        ];
        const missing = alwaysReachable.filter((phase) => !report.phases.has(phase));
        expect(
            missing,
            `phases never visited: ${missing.join(', ')} (visited: ${[...report.phases].join(', ')})`,
        ).toEqual([]);

        // SHERIFF_ELECTION and DAY only exist if some game survived the first night. In a run
        // group where every game ended at the first dawn they are structurally unreachable, so
        // say that instead of failing blindly.
        if (report.gamesPastFirstDawn > 0) {
            expect(
                report.phases.has(Phase.SHERIFF_ELECTION),
                'a game survived the first dawn, so SHERIFF_ELECTION must have been visited',
            ).toBe(true);
            expect(
                report.phases.has(Phase.DAY),
                'a game survived the first dawn, so DAY must have been visited',
            ).toBe(true);
        } else {
            console.log(
                '[fuzz] coverage note: SHERIFF_ELECTION and DAY were unreachable in this run group -- ' +
                    'every game ended at the first dawn (no game survived the first night).',
            );
        }
    });
});
