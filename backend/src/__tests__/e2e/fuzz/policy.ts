// The fuzz driver's action policy.
//
// Legality comes *only* from the public snapshot: every `kind: 'legal'` action is one the
// server is expected to accept, and a rejection of one is a bug. `kind: 'chaos'` actions are
// plausible-but-likely-illegal probes (double vote, vote for a corpse, act a second time); a
// rejection of those is expected and is the point of probing them.
//
// Progress bias: when it is a client's turn the client acts with certainty. A random game that
// cannot produce a single legal action is a deadlock and the driver fails -- `managerAdvance` is
// deliberately never used, because the escape hatch is for AFK humans, not for the fuzzer.
//
// Exploration bias: a naive "always progress" policy only ever walks the happy path. Several
// named branches are therefore forced with real probability (see BRANCH_PROBABILITY). The
// branches are picked once per run in `planRun` and are recorded in the action log as
// `[branch:...]`, so a failing run says which ones it took.

import { Phase } from '@shared/phases.js';
import { Role } from '@shared/roles.js';
import type { Client, Snapshot, SnapshotPlayer } from '../harness.js';
import type { Rng } from './prng.js';

export type ActionKind = 'legal' | 'chaos';

export interface Action {
    event: string;
    payload: Record<string, unknown>;
    kind: ActionKind;
    /** Set when the action exists only to reach a named hard branch. */
    branch?: string;
}

export interface ActionRecord {
    round: number;
    phase: Phase;
    actor: string;
    event: string;
    payload: Record<string, unknown>;
    kind: ActionKind;
    branch?: string;
}

/**
 * Probabilities for the hard branches the brief asks to keep reachable.
 * These are consumed once per run in `planRun`; they do not compete with the chaos probability.
 */
export const BRANCH_PROBABILITY = {
    /** every living player abstains from nominating on the first day -> no candidate resolution */
    allAbstainDay: 0.08,
    /** two candidates split the lynch vote evenly -> `getVotingWinner` no-winner path */
    tiedLynch: 0.1,
    /** an elected sheriff never accepts -> the GM-continue path */
    sheriffDeclines: 0.1,
    /** the whole election abstains -> no sheriff into the day, so ties cannot be broken */
    noSheriff: 0.08,
    /** the witch burns her potions at the first opportunity -> no save later in the game */
    witchSavesNobody: 0.12,
    /** witch poison + day-1 lynch remove the pack before day 2 -> very early village win */
    earlyVillageWin: 0.1,
} as const;

/** Chance per decision step to emit a plausible-but-illegal probe instead of the next legal action. */
export const CHAOS_PROBABILITY = 0.08;

/** Ordinary randomness: a player may simply abstain instead of acting. */
export const ABSTAIN_NOMINATION_PROBABILITY = 0.12;
export const ABSTAIN_VOTE_PROBABILITY = 0.12;

export interface HardBranches {
    allAbstainDay: boolean;
    tiedLynch: boolean;
    sheriffDeclines: boolean;
    noSheriff: boolean;
    witchSavesNobody: boolean;
    earlyVillageWin: boolean;
}

export interface RunPlan {
    playerCount: number;
    /** Wire shape for `roleDistribution`: role -> amount, only non-zero entries. */
    composition: Record<string, number>;
    branches: HardBranches;
}

export type DayMode = 'normal' | 'abstain' | 'tie' | 'early-wolf';

/**
 * Mutable per-run memory. It is part of the seeded state: the same seed replays the same
 * memory transitions, because every write is driven by a snapshot and the seeded rng.
 */
export interface PolicyMemory {
    /** Observed round (0 for the first night, 1 for the second, ...). Set by the driver. */
    round: number;
    /** Number of executed lobby actions, used to keep the lobby short. */
    lobbySteps: number;
    /** `${round}` of the night currently being played. */
    nightKey: string | null;
    /** The witch already emitted `usePotion` during the current night; next step confirms. */
    witchPotionSent: boolean;
    /** `${round}` of the day whose coordination plan was chosen. */
    dayKey: string | null;
    dayMode: DayMode;
    dayBranch: string | null;
    tiePair: [string, string] | null;
    earlyWolfTarget: string | null;
    /** Player the sheriff election is deliberately steered towards (declines branch). */
    electionTarget: string | null;
    usedAllAbstain: boolean;
    usedTie: boolean;
    usedEarlyWin: boolean;
}

export interface PolicyContext {
    plan: RunPlan;
    memory: PolicyMemory;
    /**
     * True roles by playerUUID, reconstructed from every client's own snapshot.
     * Used for the pack (a wolf must not vote for a wolf) and for the deliberately forced
     * early-village-win branch. It never makes an action legal that the snapshot rejects.
     */
    oracle: Map<string, Role>;
    /** The game manager's playerUUID, so the declines branch can elect somebody else. */
    managerUUID: string | null;
}

export function newPolicyMemory(): PolicyMemory {
    return {
        round: 0,
        lobbySteps: 0,
        nightKey: null,
        witchPotionSent: false,
        dayKey: null,
        dayMode: 'normal',
        dayBranch: null,
        tiePair: null,
        earlyWolfTarget: null,
        electionTarget: null,
        usedAllAbstain: false,
        usedTie: false,
        usedEarlyWin: false,
    };
}

const OPTIONAL_WAKING_ROLES: Role[] = [Role.CUPID, Role.RED_LADY, Role.SEER, Role.WITCH];

/**
 * Random valid composition: 1..floor(n/3) werewolves, each optional waking role with 50%
 * chance while the budget lasts, the rest villagers. Werewolf already satisfies the
 * "at least one role wakes up" requirement of `roleDistribution`.
 */
export function randomComposition(rng: Rng, playerCount: number): Record<string, number> {
    const maxWolves = Math.max(1, Math.floor(playerCount / 3));
    const wolfCount = rng.int(1, maxWolves);

    let budget = playerCount - wolfCount;
    const optional: Role[] = [];
    for (const role of rng.shuffle(OPTIONAL_WAKING_ROLES)) {
        if (budget <= 0) break;
        if (rng.bool(0.5)) {
            optional.push(role);
            budget--;
        }
    }

    const composition: Record<string, number> = { [Role.WEREWOLF]: wolfCount };
    for (const role of optional) composition[role] = (composition[role] ?? 0) + 1;
    const villagers = playerCount - wolfCount - optional.length;
    if (villagers > 0) composition[Role.VILLAGER] = villagers;

    const sum = Object.values(composition).reduce((total, amount) => total + amount, 0);
    if (sum !== playerCount) throw new Error(`composition sums to ${sum}, expected ${playerCount}`);
    return composition;
}

export function planRun(rng: Rng, playerCount: number): RunPlan {
    return {
        playerCount,
        composition: randomComposition(rng, playerCount),
        branches: {
            allAbstainDay: rng.bool(BRANCH_PROBABILITY.allAbstainDay),
            tiedLynch: rng.bool(BRANCH_PROBABILITY.tiedLynch),
            sheriffDeclines: rng.bool(BRANCH_PROBABILITY.sheriffDeclines),
            noSheriff: rng.bool(BRANCH_PROBABILITY.noSheriff),
            witchSavesNobody: rng.bool(BRANCH_PROBABILITY.witchSavesNobody),
            earlyVillageWin: rng.bool(BRANCH_PROBABILITY.earlyVillageWin),
        },
    };
}

// --- snapshot helpers -------------------------------------------------------

const living = (s: Snapshot): SnapshotPlayer[] => s.players.filter((p) => p.isAlive);

const meOf = (s: Snapshot): SnapshotPlayer | null =>
    s.players.find((p) => p.playerUUID === s.playerUUID) ?? null;

const isWolf = (ctx: PolicyContext, uuid: string): boolean => ctx.oracle.get(uuid) === Role.WEREWOLF;

const nominatedUUIDs = (s: Snapshot): Set<string> => {
    const set = new Set<string>();
    for (const p of s.players) if (typeof p.nomination === 'string') set.add(p.nomination);
    return set;
};

const nominees = (s: Snapshot): string[] => [...new Set(nominatedUUIDs(s))];

const distinctPair = (rng: Rng, players: SnapshotPlayer[]): [SnapshotPlayer, SnapshotPlayer] | null => {
    if (players.length < 2) return null;
    const shuffled = rng.shuffle(players);
    return [shuffled[0] as SnapshotPlayer, shuffled[1] as SnapshotPlayer];
};

// --- coordination plans -----------------------------------------------------

function ensureNight(ctx: PolicyContext): void {
    const key = `${ctx.memory.round}`;
    if (ctx.memory.nightKey === key) return;
    ctx.memory.nightKey = key;
    ctx.memory.witchPotionSent = false;
}

function ensureDay(s: Snapshot, rng: Rng, ctx: PolicyContext): void {
    const key = `${ctx.memory.round}`;
    if (ctx.memory.dayKey === key) return;
    ctx.memory.dayKey = key;
    ctx.memory.tiePair = null;
    ctx.memory.earlyWolfTarget = null;
    ctx.memory.dayBranch = null;
    ctx.memory.dayMode = 'normal';

    const alive = living(s);

    // Priority 1: end the game through the village win before day 2.
    if (ctx.plan.branches.earlyVillageWin && ctx.memory.round === 0 && !ctx.memory.usedEarlyWin) {
        const wolves = alive.filter((p) => isWolf(ctx, p.playerUUID));
        if (wolves.length > 0) {
            ctx.memory.usedEarlyWin = true;
            ctx.memory.dayMode = 'early-wolf';
            ctx.memory.earlyWolfTarget = rng.pick(wolves).playerUUID;
            ctx.memory.dayBranch = 'early-village-win';
            return;
        }
    }

    // Priority 2: force an even split so the no-winner tie path runs.
    if (ctx.plan.branches.tiedLynch && !ctx.memory.usedTie) {
        const pair = distinctPair(rng, alive);
        if (pair) {
            ctx.memory.usedTie = true;
            ctx.memory.dayMode = 'tie';
            ctx.memory.tiePair = [pair[0].playerUUID, pair[1].playerUUID];
            ctx.memory.dayBranch = 'tie';
            return;
        }
    }

    // Priority 3: everybody abstains -> no candidates at all.
    if (ctx.plan.branches.allAbstainDay && !ctx.memory.usedAllAbstain) {
        ctx.memory.usedAllAbstain = true;
        ctx.memory.dayMode = 'abstain';
        ctx.memory.dayBranch = 'all-abstain';
    }
}

// --- actions ----------------------------------------------------------------

const legal = (event: string, payload: Record<string, unknown>, branch?: string): Action =>
    branch ? { event, payload, kind: 'legal', branch } : { event, payload, kind: 'legal' };

const accept = (s: Snapshot, branch?: string): Action => legal('acceptSheriffRole', { gameId: s.gameId }, branch);

function lobbyAction(s: Snapshot, me: SnapshotPlayer, rng: Rng, ctx: PolicyContext): Action | null {
    const unnamed = s.players.filter((p) => !p.displayName);
    if (s.isManager && (unnamed.length === 0 || ctx.memory.lobbySteps >= 3)) {
        return legal('closeJoining', { gameId: s.gameId });
    }
    // Every unnamed player renames itself once; that guarantees a legal action every step and
    // keeps the lobby to at most four steps.
    if (!me.displayName) {
        return legal('changeName', { gameId: s.gameId, playerName: `Fuzz ${rng.int(1, 999)}` });
    }
    return null;
}

function nightAction(s: Snapshot, me: SnapshotPlayer, rng: Rng, ctx: PolicyContext): Action | null {
    if (!me.isAlive) return null;
    const role = s.activeNightRole as Role | null;
    if (!role) return null;

    if (role === Role.CUPID) {
        if (s.role === Role.CUPID && !s.cupidSelectedLovers) {
            const pair = distinctPair(rng, living(s));
            if (!pair) return null;
            return legal('bindLovers', {
                gameId: s.gameId,
                firstPlayerUUID: pair[0].playerUUID,
                secondPlayerUUID: pair[1].playerUUID,
            });
        }
        // The lover (or a self-bound cupid) confirms the bond during the cupid sub-turn.
        if (s.lovePartnerUUID !== null && !s.lovePartnerConfirmed) {
            return legal('confirmLoverBond', { gameId: s.gameId });
        }
        return null;
    }

    if (role === Role.WEREWOLF && s.role === Role.WEREWOLF) {
        const votes = s.werewolfVotes ?? {};
        if (votes[me.playerUUID] !== undefined) return null;
        const targets = living(s).filter(
            (p) => p.playerUUID !== me.playerUUID && !isWolf(ctx, p.playerUUID),
        );
        if (targets.length === 0) return null;

        // Pack convergence: a wolf that votes after a pack mate follows the current plurality.
        // The first vote is uniform over legal victims. Without this, multi-wolf nights would
        // almost always tie and the game would never progress.
        const counts = new Map<string, number>();
        for (const target of Object.values(votes)) counts.set(target, (counts.get(target) ?? 0) + 1);
        let leaders: string[] = [];
        let max = 0;
        for (const [uuid, count] of counts) {
            if (count > max) {
                max = count;
                leaders = [uuid];
            } else if (count === max) {
                leaders.push(uuid);
            }
        }
        const legalLeaders = leaders.filter((uuid) => targets.some((p) => p.playerUUID === uuid));
        const targetUUID = max > 0 && legalLeaders.length > 0
            ? rng.pick(legalLeaders)
            : rng.pick(targets).playerUUID;
        return legal('werewolfVote', { gameId: s.gameId, targetUUID });
    }

    if (role === Role.SEER && s.role === Role.SEER) {
        if (s.seerRevealUUID === null) {
            const targets = living(s).filter((p) => p.playerUUID !== me.playerUUID);
            if (targets.length === 0) return legal('seerConfirmed', { gameId: s.gameId });
            return legal('revealRole', { gameId: s.gameId, revealUUID: rng.pick(targets).playerUUID });
        }
        return legal('seerConfirmed', { gameId: s.gameId });
    }

    if (role === Role.WITCH && s.role === Role.WITCH) {
        if (ctx.memory.witchPotionSent) return legal('witchConfirms', { gameId: s.gameId });

        const victim = s.werewolfVictim;
        const killTargets = living(s).filter(
            (p) => p.playerUUID !== me.playerUUID && p.playerUUID !== victim,
        );
        const canHeal = !s.witchUsedHealingPotion && victim !== null;
        const canKill = !s.witchUsedKillingPotion && killTargets.length > 0;

        // Forced early village win: poison a pack member on the first night.
        if (ctx.plan.branches.earlyVillageWin && ctx.memory.round === 0 && canKill) {
            const wolves = killTargets.filter((p) => isWolf(ctx, p.playerUUID));
            if (wolves.length > 0) {
                ctx.memory.witchPotionSent = true;
                return legal(
                    'usePotion',
                    { gameId: s.gameId, heal: false, killUUID: rng.pick(wolves).playerUUID },
                    'early-village-win',
                );
            }
        }

        // "Witch saves nobody": spend every remaining potion as early as possible, so a later
        // werewolf kill has nothing left to heal.
        if (ctx.plan.branches.witchSavesNobody && (canHeal || canKill)) {
            ctx.memory.witchPotionSent = true;
            return legal(
                'usePotion',
                {
                    gameId: s.gameId,
                    heal: canHeal,
                    killUUID: canKill ? rng.pick(killTargets).playerUUID : null,
                },
                'witch-spent',
            );
        }

        const roll = rng.next();
        if (canHeal && roll < 0.35) {
            const alsoKill = canKill && rng.bool(0.35);
            ctx.memory.witchPotionSent = true;
            return legal('usePotion', {
                gameId: s.gameId,
                heal: true,
                killUUID: alsoKill ? rng.pick(killTargets).playerUUID : null,
            });
        }
        if (canKill && roll < 0.6) {
            ctx.memory.witchPotionSent = true;
            return legal('usePotion', {
                gameId: s.gameId,
                heal: false,
                killUUID: rng.pick(killTargets).playerUUID,
            });
        }
        return legal('witchConfirms', { gameId: s.gameId });
    }

    if (role === Role.RED_LADY && s.role === Role.RED_LADY) {
        if (s.redLadySleepoverUUID !== null) return null;
        const targets = living(s).filter((p) => p.playerUUID !== me.playerUUID);
        if (targets.length === 0) return null;
        return legal('sleepover', { gameId: s.gameId, sleepoverUUID: rng.pick(targets).playerUUID });
    }

    return null;
}

function ensureElection(s: Snapshot, rng: Rng, ctx: PolicyContext): void {
    if (s.sheriffElectionDone || ctx.memory.electionTarget !== null) return;
    // The declines branch needs a sheriff to exist, otherwise it cannot be observed. Steer the
    // election to a single candidate, but only for a non-manager (the point is that the elected
    // player stays silent and the GM has to continue). This takes priority over noSheriff;
    // "no sheriff" also happens naturally whenever the election ties.
    if (!ctx.plan.branches.sheriffDeclines) return;
    const candidates = living(s).filter((p) => p.playerUUID !== ctx.managerUUID);
    const pool = candidates.length > 0 ? candidates : living(s);
    if (pool.length === 0) return;
    ctx.memory.electionTarget = rng.pick(pool).playerUUID;
}

function electionVote(s: Snapshot, me: SnapshotPlayer, rng: Rng, ctx: PolicyContext): Action | null {
    if (!me.isAlive || s.myVoteTargetUUID !== null) return null;
    // Direct election: every living player is a candidate, there is no nomination stage.
    const candidates = living(s).map((p) => p.playerUUID);
    if (candidates.length === 0) return null;

    if (ctx.memory.electionTarget !== null) {
        // Everybody backs the single coordinated candidate -> a unique winner, not a tie.
        return legal('vote', { gameId: s.gameId, voteTargetUUID: ctx.memory.electionTarget }, 'sheriff-declines');
    }

    if (ctx.plan.branches.noSheriff) {
        return legal('vote', { gameId: s.gameId, voteTargetUUID: false }, 'no-sheriff');
    }
    if (rng.bool(ABSTAIN_VOTE_PROBABILITY)) {
        return legal('vote', { gameId: s.gameId, voteTargetUUID: false });
    }
    return legal('vote', { gameId: s.gameId, voteTargetUUID: rng.pick(candidates) });
}

function sheriffElectionAction(s: Snapshot, me: SnapshotPlayer, rng: Rng, ctx: PolicyContext): Action | null {
    // Voting needs a living player; accepting the result does not: the game explicitly lets a
    // dead GM open the day when the election produced no sheriff.
    if (!s.sheriffElectionDone) {
        ensureElection(s, rng, ctx);
        return electionVote(s, me, rng, ctx);
    }

    const sheriff = s.players.find((p) => p.isSheriff)?.playerUUID ?? null;
    if (!sheriff) return s.isManager ? accept(s) : null;
    if (ctx.plan.branches.sheriffDeclines) {
        // The elected sheriff sits on the badge; only the GM may open the day.
        return s.isManager ? accept(s, 'sheriff-declines') : null;
    }
    return me.playerUUID === sheriff ? accept(s) : null;
}

function dayNomination(s: Snapshot, me: SnapshotPlayer, rng: Rng, ctx: PolicyContext): Action | null {
    if (!me.isAlive || s.myNominationUUID !== null) return null;

    if (ctx.memory.dayMode === 'abstain') {
        return legal('nominate', { gameId: s.gameId, nominationUUID: false }, 'all-abstain');
    }

    const aliveSorted = living(s).map((p) => p.playerUUID).sort();
    const myIndex = aliveSorted.indexOf(me.playerUUID);

    if (ctx.memory.dayMode === 'early-wolf' && ctx.memory.earlyWolfTarget) {
        return legal('nominate', {
            gameId: s.gameId,
            nominationUUID: myIndex === 0 ? ctx.memory.earlyWolfTarget : false,
        }, 'early-village-win');
    }

    if (ctx.memory.dayMode === 'tie' && ctx.memory.tiePair) {
        const nominationUUID = myIndex === 0
            ? ctx.memory.tiePair[0]
            : myIndex === 1
                ? ctx.memory.tiePair[1]
                : false;
        return legal('nominate', { gameId: s.gameId, nominationUUID }, 'tie');
    }

    if (rng.bool(ABSTAIN_NOMINATION_PROBABILITY)) {
        return legal('nominate', { gameId: s.gameId, nominationUUID: false });
    }
    const taken = nominatedUUIDs(s);
    const options = living(s).filter((p) => !taken.has(p.playerUUID));
    return legal('nominate', {
        gameId: s.gameId,
        nominationUUID: options.length > 0 ? rng.pick(options).playerUUID : false,
    });
}

function dayVote(s: Snapshot, me: SnapshotPlayer, rng: Rng, ctx: PolicyContext): Action | null {
    if (!me.isAlive || s.myVoteTargetUUID !== null) return null;
    const candidates = nominees(s);

    if (ctx.memory.dayMode === 'tie' && ctx.memory.tiePair) {
        const [a, b] = ctx.memory.tiePair;
        if (candidates.includes(a) && candidates.includes(b)) {
            const sheriff = s.players.find((p) => p.isSheriff)?.playerUUID ?? null;
            const voters = living(s)
                .map((p) => p.playerUUID)
                .sort()
                .filter((uuid) => uuid !== sheriff);
            // An odd number of split voters would produce a winner, so one abstains.
            const active = voters.length % 2 === 0 ? voters : voters.slice(0, -1);
            if (active.length >= 2) {
                const index = active.indexOf(me.playerUUID);
                if (index === -1) return legal('vote', { gameId: s.gameId, voteTargetUUID: false }, 'tie');
                const target = index < active.length / 2 ? a : b;
                return legal('vote', { gameId: s.gameId, voteTargetUUID: target }, 'tie');
            }
        }
    }

    if (ctx.memory.dayMode === 'early-wolf' && ctx.memory.earlyWolfTarget) {
        const target = candidates.includes(ctx.memory.earlyWolfTarget)
            ? ctx.memory.earlyWolfTarget
            : candidates.length > 0 ? rng.pick(candidates) : null;
        return legal('vote', {
            gameId: s.gameId,
            voteTargetUUID: target ?? false,
        }, 'early-village-win');
    }

    if (candidates.length === 0 || rng.bool(ABSTAIN_VOTE_PROBABILITY)) {
        return legal('vote', { gameId: s.gameId, voteTargetUUID: false });
    }
    return legal('vote', { gameId: s.gameId, voteTargetUUID: rng.pick(candidates) });
}

function dayAction(s: Snapshot, me: SnapshotPlayer, rng: Rng, ctx: PolicyContext): Action | null {
    if (!me.isAlive) return null;
    if (!s.nominationsFinished) return dayNomination(s, me, rng, ctx);
    if (!s.lynchDone) return dayVote(s, me, rng, ctx);
    if (!s.readyForNight) return legal('readyForNight', { gameId: s.gameId });
    return null;
}

/**
 * The next legal action for `client`, or null when it is not this client's turn / this client
 * has nothing legal to do. Pure with respect to the server: the returned action is derived from
 * the snapshot the server just broadcast.
 */
export function chooseAction(
    client: Client,
    snapshot: Snapshot,
    rng: Rng,
    ctx: PolicyContext,
): Action | null {
    if (snapshot.playerUUID !== client.playerUUID) {
        throw new Error(`policy: snapshot ${snapshot.playerUUID} does not belong to client ${client.playerUUID}`);
    }
    const me = meOf(snapshot);
    if (!me) return null;

    if (snapshot.phase === Phase.NIGHT && snapshot.activeNightRole !== null) ensureNight(ctx);
    if (snapshot.phase === Phase.DAY) ensureDay(snapshot, rng, ctx);

    switch (snapshot.phase) {
        case Phase.LOBBY:
            return lobbyAction(snapshot, me, rng, ctx);
        case Phase.ROLE_SELECTION:
            return snapshot.isManager
                ? legal('roleDistribution', { gameId: snapshot.gameId, roles: ctx.plan.composition })
                : null;
        case Phase.DISTRIBUTION:
            return snapshot.isManager ? legal('startGame', { gameId: snapshot.gameId }) : null;
        case Phase.NIGHT:
            return nightAction(snapshot, me, rng, ctx);
        case Phase.SHERIFF_ELECTION:
            return sheriffElectionAction(snapshot, me, rng, ctx);
        case Phase.DAY:
            return dayAction(snapshot, me, rng, ctx);
        case Phase.GAME_OVER:
            return null;
        default:
            return null;
    }
}

/**
 * A plausible but probably illegal action: double vote, vote for a corpse, repeat a night
 * action. The driver treats a rejection as expected and an acceptance as fine.
 */
export function chooseChaosAction(
    client: Client,
    snapshot: Snapshot,
    rng: Rng,
    ctx: PolicyContext,
): Action | null {
    if (snapshot.playerUUID !== client.playerUUID) return null;
    const me = meOf(snapshot);
    if (!me) return null;

    if (snapshot.phase === Phase.NIGHT && me.isAlive) {
        if (snapshot.role === Role.SEER && snapshot.seerRevealUUID !== null) {
            const targets = living(snapshot).filter((p) => p.playerUUID !== me.playerUUID);
            if (targets.length > 0) {
                return { event: 'revealRole', payload: { gameId: snapshot.gameId, revealUUID: rng.pick(targets).playerUUID }, kind: 'chaos' };
            }
        }
        if (snapshot.role === Role.WEREWOLF && (snapshot.werewolfVotes ?? {})[me.playerUUID] !== undefined) {
            const targets = living(snapshot).filter((p) => p.playerUUID !== me.playerUUID);
            if (targets.length > 0) {
                return { event: 'werewolfVote', payload: { gameId: snapshot.gameId, targetUUID: rng.pick(targets).playerUUID }, kind: 'chaos' };
            }
        }
        if (snapshot.role === Role.CUPID && snapshot.cupidSelectedLovers) {
            const pair = distinctPair(rng, living(snapshot));
            if (pair) {
                return {
                    event: 'bindLovers',
                    payload: { gameId: snapshot.gameId, firstPlayerUUID: pair[0].playerUUID, secondPlayerUUID: pair[1].playerUUID },
                    kind: 'chaos',
                };
            }
        }
        if (snapshot.role === Role.RED_LADY && snapshot.redLadySleepoverUUID !== null) {
            const targets = living(snapshot).filter((p) => p.playerUUID !== me.playerUUID);
            if (targets.length > 0) {
                return { event: 'sleepover', payload: { gameId: snapshot.gameId, sleepoverUUID: rng.pick(targets).playerUUID }, kind: 'chaos' };
            }
        }
        if (snapshot.role === Role.WITCH && snapshot.witchUsedHealingPotion) {
            return { event: 'usePotion', payload: { gameId: snapshot.gameId, heal: true, killUUID: null }, kind: 'chaos' };
        }
        if (snapshot.role === Role.WITCH && snapshot.witchUsedKillingPotion) {
            const targets = living(snapshot).filter((p) => p.playerUUID !== me.playerUUID);
            if (targets.length > 0) {
                return { event: 'usePotion', payload: { gameId: snapshot.gameId, heal: false, killUUID: rng.pick(targets).playerUUID }, kind: 'chaos' };
            }
        }
        return null;
    }

    if ((snapshot.phase === Phase.DAY || snapshot.phase === Phase.SHERIFF_ELECTION) && me.isAlive) {
        // Double vote / double nomination.
        if (snapshot.nominationsFinished && snapshot.myVoteTargetUUID !== null) {
            return { event: 'vote', payload: { gameId: snapshot.gameId, voteTargetUUID: false }, kind: 'chaos' };
        }
        if (snapshot.myNominationUUID !== null) {
            return { event: 'nominate', payload: { gameId: snapshot.gameId, nominationUUID: false }, kind: 'chaos' };
        }
        // Target a corpse.
        const corpse = snapshot.players.find((p) => !p.isAlive);
        if (corpse) {
            if (snapshot.phase === Phase.DAY && snapshot.nominationsFinished) {
                return { event: 'vote', payload: { gameId: snapshot.gameId, voteTargetUUID: corpse.playerUUID }, kind: 'chaos' };
            }
            return { event: 'nominate', payload: { gameId: snapshot.gameId, nominationUUID: corpse.playerUUID }, kind: 'chaos' };
        }
    }

    return null;
}
