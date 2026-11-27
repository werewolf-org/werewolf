import { describe, it, expect, afterEach } from 'vitest';
import { TestGame } from './harness.js';
import type { Client, Snapshot } from './harness.js';
import { Phase } from '@shared/phases.js';
import { Role } from '@shared/roles.js';

// Voting and sheriff combinatorics over the real socket contract: ties (with and without a
// badge), abstains, nomination rules, vote integrity, what a lynch does to the game, the day
// and election structure, and the GM escape hatch in every day stage.
//
// Roles are dealt at random, so every test discovers them from the snapshots. The compositions
// below only fix which roles exist, never who has them. `game-flow.test.ts` already owns the
// clean election + plurality day; nothing here repeats it.

// 5 players, no Cupid/Red Lady: night order is Werewolf -> Seer -> Witch.
// Two wolves can split their votes, which decides no victim at all, so night 0 can be deathless.
const FIVE: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.SEER]: 1,
    [Role.WITCH]: 1,
    [Role.VILLAGER]: 1,
};

// 6 players, same idea: enough voters for a three-way 2-2-2 tie.
const SIX: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.SEER]: 1,
    [Role.WITCH]: 1,
    [Role.VILLAGER]: 2,
};

// 6 players with a Cupid, so a lynch can take a lover down with it.
const SIX_LOVERS: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.CUPID]: 1,
    [Role.SEER]: 1,
    [Role.WITCH]: 1,
    [Role.VILLAGER]: 1,
};

// 5 players, a single wolf: lynching it is the last wolf, so the game must end on the spot.
const FIVE_ONE_WOLF: Record<string, number> = {
    [Role.WEREWOLF]: 1,
    [Role.SEER]: 1,
    [Role.WITCH]: 1,
    [Role.VILLAGER]: 2,
};

let game: TestGame | null = null;

afterEach(async () => {
    await game?.close();
    game = null;
});

// --- local helpers (the harness is owned elsewhere; nothing here needs a harness change) ---

const name = (client: Client): string => `player ${client.playerUUID}`;

function isAlive(client: Client): boolean {
    return client.state?.players.find((p) => p.playerUUID === client.playerUUID)?.isAlive === true;
}

/** Living players, read from the clients' own snapshots (roles are never assumed). */
function livingClients(target: TestGame): Client[] {
    return target.clients.filter(isAlive);
}

/** The trial ballot as a snapshot watcher can derive it: distinct nominated targets, sorted. */
function candidatesIn(state: Snapshot): string[] {
    return [...new Set(
        state.players
            .map((p) => p.nomination)
            .filter((nomination): nomination is string => typeof nomination === 'string'),
    )].sort();
}

/** The one client holding `role`. Fails the test if the count is not exactly one. */
function only(target: TestGame, role: Role): Client {
    const found = target.clientsWithRole(role);
    expect(found.length, `expected exactly one client with role ${role}`).toBe(1);
    return found[0]!;
}

function forEachSnapshot(
    target: TestGame,
    filter: (state: Snapshot) => boolean,
    check: (state: Snapshot, where: string) => void,
): void {
    for (const client of target.clients) {
        client.history.forEach((state, index) => {
            if (!filter(state)) return;
            check(state, `${name(client)} snapshot #${index} (${state.phase})`);
        });
    }
}

interface NightPlan {
    /** One target per living werewolf. Two different targets mean "the pack agrees on nothing", so nobody dies. */
    wolfTargets: Client[];
    /** The pair cupid binds; only needed when a cupid is in the game. */
    lovers?: [Client, Client];
    /** Whether the witch heals the pack's victim. Omitted means she passes. */
    heal?: boolean;
}

/**
 * Plays every sub-turn of the current night with the real action contract and returns the roles
 * that woke up, in order. The witch only heals when the plan says so; every other role does the
 * smallest legal thing that advances the night.
 */
async function playNight(target: TestGame, plan: NightPlan): Promise<string[]> {
    const watcher = target.manager;
    const woke: string[] = [];
    let guard = 0;

    while (watcher.state!.phase === Phase.NIGHT) {
        if (++guard > 12) throw new Error('the night did not end after 12 sub-turns');
        const role = watcher.state!.activeNightRole;
        if (!role) throw new Error('NIGHT without an active role');
        woke.push(role);

        await Promise.all(target.clients.map((c) => c.waitForTurn(role)));

        switch (role) {
            case Role.CUPID: {
                const cupid = only(target, Role.CUPID);
                const pair = plan.lovers;
                if (!pair) throw new Error(`night plan has no lover pair for the cupid`);
                const [first, second] = pair;
                cupid.socket.emit('bindLovers', {
                    gameId: target.gameId,
                    firstPlayerUUID: first.playerUUID,
                    secondPlayerUUID: second.playerUUID,
                });
                await cupid.waitFor(
                    (s) => s.cupidFirstLoverUUID === first.playerUUID,
                    'the cupid bound the lovers',
                );
                first.socket.emit('confirmLoverBond', { gameId: target.gameId });
                await cupid.waitFor(
                    (s) => s.cupidFirstLoverConfirmed || s.cupidSecondLoverConfirmed,
                    'one lover confirmed the bond',
                );
                second.socket.emit('confirmLoverBond', { gameId: target.gameId });
                break;
            }
            case Role.WEREWOLF: {
                const wolves = livingClients(target).filter((c) => c.state?.role === Role.WEREWOLF);
                expect(plan.wolfTargets.length, 'the plan needs one target per living werewolf').toBe(
                    wolves.length,
                );
                wolves.forEach((wolf, i) =>
                    wolf.socket.emit('werewolfVote', {
                        gameId: target.gameId,
                        targetUUID: plan.wolfTargets[i]!.playerUUID,
                    }),
                );
                break;
            }
            case Role.SEER: {
                only(target, Role.SEER).socket.emit('seerConfirmed', { gameId: target.gameId });
                break;
            }
            case Role.WITCH: {
                const witch = only(target, Role.WITCH);
                if (plan.heal) {
                    witch.socket.emit('usePotion', {
                        gameId: target.gameId,
                        heal: true,
                        killUUID: null,
                    });
                    await witch.waitFor((s) => s.witchUsedHealingPotion, 'the witch healed the victim');
                }
                witch.socket.emit('witchConfirms', { gameId: target.gameId });
                break;
            }
            default:
                throw new Error(`voting.test.ts has no driver for the waking role ${role}`);
        }

        await watcher.waitFor(
            (s) => s.phase !== Phase.NIGHT || s.activeNightRole !== role,
            `the ${role} turn to end`,
        );
    }

    return woke;
}

/** The two wolves bite two different players, so no victim is decided and nobody dies. */
function splitVotes(target: TestGame): Client[] {
    const living = livingClients(target);
    const wolves = living.filter((c) => c.state?.role === Role.WEREWOLF);
    const others = living.filter((c) => c.state?.role !== Role.WEREWOLF);
    expect(others.length, 'a split wolf vote needs two players who are not wolves').toBeGreaterThanOrEqual(
        wolves.length,
    );
    return wolves.map((_, i) => others[i]!);
}

/** Candidates plus abstains: only the listed clients emit, so everybody else stays silent. */
type Ballot = Array<[Client, Client | false]>;

const uuidOrFalse = (target: Client | false): string | false => (target === false ? false : target.playerUUID!);

async function castNominations(target: TestGame, ballot: Ballot): Promise<void> {
    const expected = new Map<string, string | false>();
    for (const [client, nominee] of ballot) expected.set(client.playerUUID!, uuidOrFalse(nominee));

    for (const [client, nominee] of ballot) {
        client.socket.emit('nominate', {
            gameId: target.gameId,
            nominationUUID: uuidOrFalse(nominee),
        });
    }

    await target.manager.waitFor(
        (s) =>
            ballot.every(([client]) => {
                const row = s.players.find((p) => p.playerUUID === client.playerUUID);
                return row !== undefined && row.nomination === expected.get(client.playerUUID!);
            }),
        'the planned nominations were recorded',
    );
    // The manager's snapshot can land before the nominator's own, so every nominator confirms too.
    await Promise.all(
        ballot.map(([client, nominee]) =>
            client.waitFor(
                (s) => s.myNominationUUID === uuidOrFalse(nominee),
                `the nomination of ${client.playerUUID}`,
            ),
        ),
    );
}

async function castVotes(target: TestGame, ballot: Ballot): Promise<void> {
    for (const [client, voteTarget] of ballot) {
        client.socket.emit('vote', { gameId: target.gameId, voteTargetUUID: uuidOrFalse(voteTarget) });
    }
    await Promise.all(
        ballot.map(([client, voteTarget]) =>
            client.waitFor(
                (s) => s.myVoteTargetUUID === uuidOrFalse(voteTarget),
                `the vote of ${client.playerUUID}`,
            ),
        ),
    );
}

/** Every living player nominates: `pick` returns a candidate or `false` for an abstain. */
async function nominateEveryone(
    target: TestGame,
    pick: (client: Client) => Client | false,
): Promise<void> {
    await castNominations(
        target,
        livingClients(target).map((c) => [c, pick(c)] as [Client, Client | false]),
    );
}

/** Every living player votes: `pick` returns a target or `false` for an abstain. */
async function voteEveryone(
    target: TestGame,
    pick: (client: Client, living: Client[]) => Client | false,
): Promise<void> {
    const living = livingClients(target);
    await castVotes(
        target,
        living.map((c) => [c, pick(c, living)] as [Client, Client | false]),
    );
}

async function waitForLynch(target: TestGame): Promise<void> {
    await Promise.all(target.clients.map((c) => c.waitFor((s) => s.lynchDone, 'the lynch resolved')));
}

/** Every living player confirms, which starts the next night. */
async function readyEveryone(target: TestGame): Promise<void> {
    for (const client of livingClients(target)) {
        client.socket.emit('readyForNight', { gameId: target.gameId });
    }
    await target.waitForPhaseEverywhere(Phase.NIGHT);
}

/** Nobody votes (all abstain), so the round-0 election resolves without a sheriff and the GM opens the day. */
async function skipElection(target: TestGame): Promise<void> {
    await castVotes(
        target,
        livingClients(target).map((c) => [c, false] as [Client, Client | false]),
    );
    await target.manager.waitFor((s) => s.sheriffElectionDone, 'the election resolved without a candidate');
    for (const client of target.clients) {
        expect(client.state!.players.some((p) => p.isSheriff), 'nobody wears a badge').toBe(false);
    }
    target.manager.socket.emit('acceptSheriffRole', { gameId: target.gameId });
    await target.waitForPhaseEverywhere(Phase.DAY);
}

/** Night 0 with a split wolf vote, ending at the round-0 sheriff election with everybody alive. */
async function firstNightAndElection(target: TestGame): Promise<void> {
    expect(target.manager.state!.phase, 'this helper expects the start of night 0').toBe(Phase.NIGHT);
    await playNight(target, { wolfTargets: splitVotes(target) });
    await target.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);
}

/** Night 0 without any death, then the round-0 election is skipped, landing in DAY. */
async function reachDay(target: TestGame): Promise<void> {
    await firstNightAndElection(target);
    await skipElection(target);
}

/** Direct vote: everybody backs `sheriff`, who then accepts the badge and opens the day. */
async function electSheriff(target: TestGame, sheriff: Client, runnerUp: Client): Promise<void> {
    expect(runnerUp, 'the runner-up is only there to make the ballot non-trivial').not.toBe(sheriff);
    await castVotes(
        target,
        livingClients(target).map((c) => [c, sheriff] as [Client, Client | false]),
    );
    const resolved = await target.manager.waitFor((s) => s.sheriffElectionDone, 'the election resolved');
    expect(resolved.players.filter((p) => p.isSheriff).map((p) => p.playerUUID)).toEqual([
        sheriff.playerUUID,
    ]);
    sheriff.socket.emit('acceptSheriffRole', { gameId: target.gameId });
    await target.waitForPhaseEverywhere(Phase.DAY);
}

/** Emits `managerAdvance`; the waiter is registered first so a fast reply cannot be missed. */
async function advanceManager(
    target: TestGame,
    predicate: (state: Snapshot) => boolean,
    label: string,
): Promise<Snapshot> {
    const waiter = target.manager.waitFor(predicate, label);
    target.manager.socket.emit('managerAdvance', { gameId: target.gameId });
    return waiter;
}

/** Emits an event the server is expected to reject and returns the error message. */
async function rejected(client: Client, event: string, payload: unknown, label: string): Promise<string> {
    const before = client.errors.length;
    const message = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`Timed out waiting for the server error after "${label}"`)),
            2000,
        );
        client.socket.once('error', (data: { message: string }) => {
            clearTimeout(timer);
            resolve(data.message);
        });
    });
    client.socket.emit(event, payload);
    const text = await message;
    expect(client.errors.length, `the rejected "${label}" was not recorded as an error`).toBe(before + 1);
    return text;
}

/** Asserts that `predicate` never becomes true: a forbidden snapshot would have to arrive first. */
async function expectNoSnapshot(
    client: Client,
    predicate: (state: Snapshot) => boolean,
    label: string,
    ms = 500,
): Promise<void> {
    await expect(client.waitFor(predicate, label, ms)).rejects.toThrow(/Timed out/);
}

describe('voting: ties', () => {
    it('1. leaves a 2-2 tie unlynched when there is no sheriff, and the day still ends', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);
        await reachDay(t);
        expect(livingClients(t)).toHaveLength(5);

        const [a, b, p2, p3, p4] = livingClients(t) as [Client, Client, Client, Client, Client];
        // a and b are the two candidates; b abstains, so the tally is 2-2 with one abstain.
        await castNominations(t, [
            [p2, a],
            [p3, b],
            [a, false],
            [b, false],
            [p4, false],
        ]);
        await castVotes(t, [
            [p2, a],
            [p3, a],
            [p4, b],
            [a, b],
            [b, false],
        ]);
        await waitForLynch(t);

        for (const client of t.clients) {
            const state = client.state!;
            expect(state.phase, `${name(client)} phase after the tie`).toBe(Phase.DAY);
            expect(state.lynchDone).toBe(true);
            expect(state.votedOutUUID, `${name(client)}: a tie without a badge must lynch nobody`).toBeNull();
            expect(state.players.every((p) => p.isAlive), `${name(client)}: the tie killed somebody`).toBe(true);
            expect(state.voteProgress?.total, `${name(client)} counts the living`).toBe(5);
        }
        // Negative space: no snapshot ever says somebody was voted out.
        forEachSnapshot(t, (s) => s.lynchDone, (s, where) => {
            expect(s.votedOutUUID, `${where}: a tie produced a victim`).toBeNull();
        });

        // The day is not stuck: the living confirm and the night starts.
        await readyEveryone(t);
        for (const client of t.clients) {
            expect(client.state!.phase).toBe(Phase.NIGHT);
            expect(client.state!.lynchDone, 'the new night resets the lynch flag').toBe(false);
        }

        t.expectNoErrors();
    });

    it('2. lets the sheriff break a 2-2 tie with their own vote', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);
        await firstNightAndElection(t);

        const first = livingClients(t);
        const sheriff = first[0]!;
        await electSheriff(t, sheriff, first[1]!);

        const others = livingClients(t).filter((c) => c !== sheriff);
        expect(others).toHaveLength(4);
        const [a, b, p3, p4] = others as [Client, Client, Client, Client];
        expect(a.state!.players.find((p) => p.playerUUID === sheriff.playerUUID)?.isSheriff).toBe(true);

        await castNominations(t, [
            [a, b],
            [b, a],
            [p3, false],
            [p4, false],
            [sheriff, false],
        ]);
        // a: sheriff + p3, b: p4 + a. Tied 2-2, and the sheriff voted for a.
        await castVotes(t, [
            [sheriff, a],
            [p3, a],
            [p4, b],
            [a, b],
            [b, false],
        ]);
        await waitForLynch(t);

        for (const client of t.clients) {
            const state = client.state!;
            expect(state.votedOutUUID, `${name(client)}: the sheriff's vote breaks the tie`).toBe(a.playerUUID);
            expect(state.players.find((p) => p.playerUUID === a.playerUUID)?.isAlive).toBe(false);
            expect(state.players.find((p) => p.playerUUID === b.playerUUID)?.isAlive).toBe(true);
            // The badge itself is untouched: only the *target* of the badge holder's vote won.
            expect(state.players.filter((p) => p.isSheriff).map((p) => p.playerUUID)).toEqual([
                sheriff.playerUUID,
            ]);
        }

        t.expectNoErrors();
    });

    it('3. lets a tied sheriff hand the tie-break to the other tied candidate', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);
        await firstNightAndElection(t);

        const first = livingClients(t);
        const sheriff = first[0]!;
        await electSheriff(t, sheriff, first[1]!);

        const others = livingClients(t).filter((c) => c !== sheriff);
        expect(others).toHaveLength(4);
        const [challenger, p2, p3, p4] = others as [Client, Client, Client, Client];

        await castNominations(t, [
            [challenger, sheriff],
            [sheriff, challenger],
            [p2, false],
            [p3, false],
            [p4, false],
        ]);
        // The badge holder points at the other tied candidate, so that one goes.
        await castVotes(t, [
            [sheriff, challenger],
            [challenger, challenger],
            [p2, sheriff],
            [p3, sheriff],
            [p4, false],
        ]);
        await waitForLynch(t);

        for (const client of t.clients) {
            const state = client.state!;
            expect(state.votedOutUUID, `${name(client)}: the tied sheriff's vote picks the target`).toBe(
                challenger.playerUUID,
            );
            expect(state.players.find((p) => p.playerUUID === challenger.playerUUID)?.isAlive).toBe(false);
            // Being tied does not cost the badge holder their life or their badge.
            expect(state.players.find((p) => p.playerUUID === sheriff.playerUUID)?.isAlive).toBe(true);
            expect(state.players.filter((p) => p.isSheriff).map((p) => p.playerUUID)).toEqual([
                sheriff.playerUUID,
            ]);
        }

        t.expectNoErrors();
    });

    it('4. does not break a tie when the sheriff abstained', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);
        await firstNightAndElection(t);

        const first = livingClients(t);
        const sheriff = first[0]!;
        await electSheriff(t, sheriff, first[1]!);

        const others = livingClients(t).filter((c) => c !== sheriff);
        const [a, b, p3, p4] = others as [Client, Client, Client, Client];

        await castNominations(t, [
            [a, b],
            [b, a],
            [p3, false],
            [p4, false],
            [sheriff, false],
        ]);
        // a: p3 + p4, b: a + b, and the badge holder abstains.
        await castVotes(t, [
            [p3, a],
            [p4, a],
            [a, b],
            [b, b],
            [sheriff, false],
        ]);
        await waitForLynch(t);

        for (const client of t.clients) {
            const state = client.state!;
            expect(state.votedOutUUID, `${name(client)}: an abstaining sheriff cannot break a tie`).toBeNull();
            expect(state.players.every((p) => p.isAlive), `${name(client)}: the tie killed somebody`).toBe(true);
            expect(state.players.filter((p) => p.isSheriff).map((p) => p.playerUUID)).toEqual([
                sheriff.playerUUID,
            ]);
        }

        t.expectNoErrors();
    });

    it('5. leaves a three-way 2-2-2 tie unlynched', async () => {
        const t = await TestGame.create({ playerCount: 6 });
        game = t;
        await t.setupAndStart(SIX);
        await reachDay(t);
        expect(livingClients(t)).toHaveLength(6);

        const [a, b, c, p1, p2, p3] = livingClients(t) as [Client, Client, Client, Client, Client, Client];
        await castNominations(t, [
            [p1, a],
            [p2, b],
            [p3, c],
            [a, false],
            [b, false],
            [c, false],
        ]);
        // Every voter is used: 2 votes each, no abstain, and no sheriff to break it.
        await castVotes(t, [
            [a, a],
            [b, a],
            [c, b],
            [p1, b],
            [p2, c],
            [p3, c],
        ]);
        await waitForLynch(t);

        for (const client of t.clients) {
            const state = client.state!;
            expect(state.votedOutUUID, `${name(client)}: a three-way tie must lynch nobody`).toBeNull();
            expect(state.players.filter((p) => p.isAlive)).toHaveLength(6);
            expect(state.voteProgress?.voted, `${name(client)} counted every ballot`).toBe(6);
        }

        t.expectNoErrors();
    });

    it('6. elects no sheriff when the election itself is tied, and only the GM can continue', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);
        await firstNightAndElection(t);

        const [a, b, p1, p2, p3] = livingClients(t) as [Client, Client, Client, Client, Client];
        // 2-2 with one abstain. There is no incumbent badge, so nothing can break the tie.
        await castVotes(t, [
            [p1, a],
            [p2, a],
            [p3, b],
            [a, b],
            [b, false],
        ]);
        const resolved = await t.manager.waitFor(
            (s) => s.sheriffElectionDone,
            'the tied election resolved',
        );

        expect(resolved.phase, 'a tied election does not open the day by itself').toBe(Phase.SHERIFF_ELECTION);
        expect(resolved.players.some((p) => p.isSheriff), 'a tie elects nobody').toBe(false);
        for (const client of t.clients) {
            expect(client.state!.players.some((p) => p.isSheriff)).toBe(false);
            expect(client.state!.phase).toBe(Phase.SHERIFF_ELECTION);
        }

        const intruder = livingClients(t).find((c) => !c.state!.isManager)!;
        const gate = await rejected(
            intruder,
            'acceptSheriffRole',
            { gameId: t.gameId },
            'a living player continues an election that elected nobody',
        );
        expect(gate).toMatch(/only gm/i);
        expect(intruder.state!.phase).toBe(Phase.SHERIFF_ELECTION);

        t.manager.socket.emit('acceptSheriffRole', { gameId: t.gameId });
        await t.waitForPhaseEverywhere(Phase.DAY);
        for (const client of t.clients) {
            expect(client.state!.sheriffElectionDone).toBe(true);
            expect(client.state!.players.some((p) => p.isSheriff)).toBe(false);
        }

        // The day is usable: a normal nomination lands and shows up as a candidate.
        await castNominations(t, [[intruder, a]]);
        expect(candidatesIn(t.manager.state!), 'the day accepted a nomination').toContain(a.playerUUID);

        // expectNoErrors() is unusable: the intruder's rejection is deliberate.
        expect(intruder.errors).toHaveLength(1);
    });
});

describe('voting: abstains', () => {
    it('7. resolves the day without a candidate when every living player abstains', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);
        await reachDay(t);

        await nominateEveryone(t, () => false);
        await waitForLynch(t);

        for (const client of t.clients) {
            const state = client.state!;
            expect(state.phase, `${name(client)} phase`).toBe(Phase.DAY);
            expect(state.lynchDone).toBe(true);
            expect(state.nominationsFinished).toBe(true);
            expect(state.votedOutUUID, `${name(client)}: nobody was nominated, nobody dies`).toBeNull();
            expect(state.players.every((p) => p.isAlive)).toBe(true);
            expect(state.voteProgress, `${name(client)}: the trial stage never opened`).toEqual({
                voted: 0,
                total: 5,
            });
            expect(state.voteResults, `${name(client)}: there was no trial to report`).toBeNull();
        }

        // The empty result screen is a legal stage: the living confirm and the night starts.
        await readyEveryone(t);
        expect(t.manager.state!.phase).toBe(Phase.NIGHT);

        t.expectNoErrors();
    });

    it('8. lynches nobody when every living player abstains from the trial vote', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);
        await reachDay(t);

        const living = livingClients(t);
        const candidate = living[0]!;
        const nominator = living[1]!;
        await castNominations(t, [
            [nominator, candidate],
            ...living.filter((c) => c !== nominator).map((c) => [c, false] as [Client, Client | false]),
        ]);
        await t.manager.waitFor((s) => s.nominationsFinished, 'the trial opened');

        await voteEveryone(t, () => false);
        await waitForLynch(t);

        for (const client of t.clients) {
            const state = client.state!;
            expect(state.votedOutUUID, `${name(client)}: all abstains lynch nobody`).toBeNull();
            expect(state.players.every((p) => p.isAlive)).toBe(true);
            expect(state.voteResults, `${name(client)}: the full abstain ballot is reported`).not.toBeNull();
            for (const [voter, target] of Object.entries(state.voteResults!)) {
                expect(target, `${name(client)}: ${voter} abstained`).toBe(false);
            }
            expect(Object.keys(state.voteResults!)).toHaveLength(5);
        }

        t.expectNoErrors();
    });

    it('9. lets one abstain decide a 2-1 day', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);

        // One villager dies in the night, so four players walk into the day.
        const villager = only(t, Role.VILLAGER);
        const wolves = livingClients(t).filter((c) => c.state?.role === Role.WEREWOLF);
        await playNight(t, { wolfTargets: wolves.map(() => villager) });
        await t.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);
        await skipElection(t);
        expect(livingClients(t)).toHaveLength(4);

        const [a, b, p3, p4] = livingClients(t) as [Client, Client, Client, Client];
        await castNominations(t, [
            [a, b],
            [b, a],
            [p3, false],
            [p4, false],
        ]);
        // a: p3 + p4, b: a. If b had voted for itself it would be 2-2 and nobody would die;
        // the single abstain is what hands a the lynch.
        await castVotes(t, [
            [p3, a],
            [p4, a],
            [a, b],
            [b, false],
        ]);
        await waitForLynch(t);

        for (const client of t.clients) {
            const state = client.state!;
            expect(state.votedOutUUID, `${name(client)}: a takes the day 2-1`).toBe(a.playerUUID);
            expect(state.players.find((p) => p.playerUUID === a.playerUUID)?.isAlive).toBe(false);
            expect(state.players.find((p) => p.playerUUID === b.playerUUID)?.isAlive).toBe(true);
        }

        t.expectNoErrors();
    });

    it('10. abstains the whole sheriff election and leaves no sheriff', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);
        await firstNightAndElection(t);

        const living = livingClients(t);
        await castVotes(
            t,
            living.map((c) => [c, false] as [Client, Client | false]),
        );
        const resolved = await t.manager.waitFor(
            (s) => s.sheriffElectionDone,
            'the election resolved with no nomination',
        );

        expect(resolved.phase, 'the election waits for the GM even when nobody ran').toBe(
            Phase.SHERIFF_ELECTION,
        );
        expect(resolved.players.some((p) => p.isSheriff)).toBe(false);
        // The direct ballots are still reported, every one of them an explicit abstain.
        expect(resolved.voteResults).not.toBeNull();
        expect(Object.keys(resolved.voteResults!).sort()).toEqual(
            resolved.players.map((p) => p.playerUUID).sort(),
        );
        for (const [voter, target] of Object.entries(resolved.voteResults!)) {
            expect(target, `${voter} abstained`).toBe(false);
        }
        expect(resolved.voteProgress).toEqual({ voted: 5, total: 5 });

        const intruder = living.find((c) => !c.state!.isManager)!;
        const gate = await rejected(
            intruder,
            'acceptSheriffRole',
            { gameId: t.gameId },
            'a player opens a day without a sheriff',
        );
        expect(gate).toMatch(/only gm/i);

        t.manager.socket.emit('acceptSheriffRole', { gameId: t.gameId });
        await t.waitForPhaseEverywhere(Phase.DAY);
        for (const client of t.clients) {
            expect(client.state!.sheriffElectionDone).toBe(true);
            expect(client.state!.players.some((p) => p.isSheriff)).toBe(false);
            expect(client.state!.lynchDone).toBe(false);
        }

        expect(intruder.errors).toHaveLength(1);
    });
});

describe('voting: nominations', () => {
    it('11. accepts a second for the same candidate and dedupes the trial ballot', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);
        await reachDay(t);

        const [p1, p2, a, p3, p4] = livingClients(t) as [Client, Client, Client, Client, Client];
        await castNominations(t, [[p1, a]]);

        // Agreeing with a nomination is legal: no first-come-first-served race, no rejection.
        await castNominations(t, [[p2, a]]);
        expect(p2.state!.myNominationUUID, 'the second was not recorded').toBe(a.playerUUID);
        expect(p2.errors, 'a second was rejected').toHaveLength(0);

        // Nominating yourself is legal too.
        await castNominations(t, [[a, a]]);
        expect(a.state!.myNominationUUID).toBe(a.playerUUID);

        await castNominations(t, [
            [p3, false],
            [p4, false],
        ]);
        await t.manager.waitFor((s) => s.nominationsFinished, 'everybody nominated');

        // Three players named `a`, but the ballot lists the candidate once.
        expect(candidatesIn(t.manager.state!), 'the ballot does not dedupe the candidate').toEqual([a.playerUUID]);
        const nominators = t.manager.state!.players
            .filter((p) => p.nomination === a.playerUUID)
            .map((p) => p.playerUUID)
            .sort();
        expect(nominators, 'the snapshot still shows every nominator').toEqual(
            [p1.playerUUID, p2.playerUUID, a.playerUUID].sort(),
        );

        // A self-nominated, seconded candidate is a normal candidate and can be voted out.
        await castVotes(
            t,
            livingClients(t).map((c) => [c, a] as [Client, Client | false]),
        );
        await waitForLynch(t);
        expect(t.manager.state!.votedOutUUID).toBe(a.playerUUID);

        expect(p2.errors).toHaveLength(0);
    });

    it('12. rejects nominating a player who died in the night', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);

        const corpse = only(t, Role.VILLAGER);
        const wolves = livingClients(t).filter((c) => c.state?.role === Role.WEREWOLF);
        await playNight(t, { wolfTargets: wolves.map(() => corpse) });
        await t.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);
        await skipElection(t);

        const living = livingClients(t);
        expect(living).toHaveLength(4);
        const nominator = living[0]!;
        const error = await rejected(
            nominator,
            'nominate',
            { gameId: t.gameId, nominationUUID: corpse.playerUUID },
            'nominating a corpse',
        );
        expect(error).toMatch(/not available/i);

        for (const client of t.clients) {
            expect(client.state!.phase).toBe(Phase.DAY);
            expect(client.state!.nominationsFinished, 'the rejected nomination did not count').toBe(false);
            expect(
                candidatesIn(client.state!),
                'a corpse showed up on the ballot',
            ).toHaveLength(0);
        }
        expect(nominator.state!.myNominationUUID).toBeNull();

        // The day still resolves once everybody abstains.
        await nominateEveryone(t, () => false);
        await waitForLynch(t);
        expect(t.manager.state!.votedOutUUID).toBeNull();

        expect(nominator.errors).toHaveLength(1);
    });

    it('13. rejects a nomination change after nominations closed', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);
        await reachDay(t);

        const [p1, p2, a, b, p4] = livingClients(t) as [Client, Client, Client, Client, Client];
        await castNominations(t, [
            [p1, a],
            [p2, false],
            [a, false],
            [b, false],
            [p4, false],
        ]);
        await t.manager.waitFor((s) => s.nominationsFinished, 'the trial opened');
        expect(t.manager.state!.lynchDone).toBe(false);

        const late = await rejected(
            p2,
            'nominate',
            { gameId: t.gameId, nominationUUID: b.playerUUID },
            'changing a nomination in the trial stage',
        );
        expect(late).toMatch(/already nominated/i);

        for (const client of t.clients) {
            const state = client.state!;
            expect(state.lynchDone, 'the rejected change resolved the day').toBe(false);
            expect(candidatesIn(state), `${name(client)}: the ballot changed`).toEqual([a.playerUUID]);
        }
        expect(p2.state!.myNominationUUID).toBe(false);

        // The trial is untouched and still resolves.
        await castVotes(
            t,
            livingClients(t).map((c) => [c, a] as [Client, Client | false]),
        );
        await waitForLynch(t);
        expect(t.manager.state!.votedOutUUID).toBe(a.playerUUID);

        expect(p2.errors).toHaveLength(1);
    });

    it('14. flips nominationsFinished exactly when the last living player nominates', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);
        await reachDay(t);

        const [p1, p2, p3, p4, last] = livingClients(t) as [Client, Client, Client, Client, Client];
        const candidate = p1;
        await castNominations(t, [
            [p2, candidate],
            [candidate, false],
            [p3, false],
            [p4, false],
        ]);

        for (const client of t.clients) {
            expect(client.state!.nominationsFinished, `${name(client)}: four of five is not finished`).toBe(
                false,
            );
            expect(client.state!.lynchDone).toBe(false);
        }

        // Exactness: no snapshot may claim the nominations are in while `last` has not nominated.
        // (`history` also holds lobby snapshots that predate this player, hence the skip.)
        for (const state of t.manager.history) {
            const row = state.players.find((p) => p.playerUUID === last.playerUUID);
            if (!row || row.nomination !== null) continue;
            expect(state.nominationsFinished, 'the stage closed before the last player nominated').toBe(false);
        }

        await castNominations(t, [[last, false]]);
        await t.manager.waitFor((s) => s.nominationsFinished, 'the last nomination closed the stage');

        for (const client of t.clients) {
            const state = client.state!;
            expect(state.nominationsFinished, `${name(client)}: the last nomination finished the stage`).toBe(true);
            expect(state.lynchDone, `${name(client)}: a candidate exists, so the trial opens`).toBe(false);
            expect(state.phase).toBe(Phase.DAY);
        }

        await castVotes(
            t,
            livingClients(t).map((c) => [c, candidate] as [Client, Client | false]),
        );
        await waitForLynch(t);
        expect(t.manager.state!.votedOutUUID).toBe(candidate.playerUUID);

        t.expectNoErrors();
    });
});

describe('voting: vote integrity', () => {
    it('15. rejects a vote before nominations, a vote for a non-candidate and a second vote', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);
        await reachDay(t);

        const [p1, p2, a, b, p4] = livingClients(t) as [Client, Client, Client, Client, Client];

        const early = await rejected(
            p1,
            'vote',
            { gameId: t.gameId, voteTargetUUID: a.playerUUID },
            'a vote before nominations finished',
        );
        expect(early).toMatch(/not started yet/i);
        expect(p1.state!.myVoteTargetUUID, 'the early vote was recorded').toBeNull();

        await castNominations(t, [
            [p1, a],
            [p2, b],
            [a, false],
            [b, false],
            [p4, false],
        ]);
        await t.manager.waitFor((s) => s.nominationsFinished, 'the trial opened');

        const stranger = await rejected(
            p1,
            'vote',
            { gameId: t.gameId, voteTargetUUID: p4.playerUUID },
            'a vote for someone who was not nominated',
        );
        expect(stranger).toMatch(/not on trial/i);
        expect(p1.state!.myVoteTargetUUID).toBeNull();

        await castVotes(t, [[p1, a]]);
        const twice = await rejected(
            p1,
            'vote',
            { gameId: t.gameId, voteTargetUUID: b.playerUUID },
            'a second vote from the same player',
        );
        expect(twice).toMatch(/already voted/i);
        expect(p1.state!.myVoteTargetUUID, 'the second vote overwrote the first').toBe(a.playerUUID);

        await castVotes(t, [
            [p2, b],
            [a, a],
            [b, a],
            [p4, a],
        ]);
        await waitForLynch(t);
        for (const client of t.clients) {
            expect(client.state!.votedOutUUID, `${name(client)}: a wins 4-1`).toBe(a.playerUUID);
        }

        expect(p1.errors).toHaveLength(3);
    });

    it('16. ignores a corpse vote, counts progress live, and reports the whole ballot at the end', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);

        const corpse = only(t, Role.VILLAGER);
        const wolves = livingClients(t).filter((c) => c.state?.role === Role.WEREWOLF);
        await playNight(t, { wolfTargets: wolves.map(() => corpse) });
        await t.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);
        await skipElection(t);

        const [p1, p2, p3, p4] = livingClients(t) as [Client, Client, Client, Client];
        // Participation is public: every snapshot says who has already decided, and an
        // abstain counts exactly like a named ballot. The choice stays private.
        const decided = (state: Snapshot): string[] =>
            state.players.filter((p) => p.isAlive && p.hasVoted).map((p) => p.playerUUID).sort();
        for (const client of t.clients) {
            expect(client.state!.voteProgress, `${name(client)}: the corpse is not in the tally`).toEqual({
                voted: 0,
                total: 4,
            });
            expect(decided(client.state!), `${name(client)}: nobody has decided yet`).toEqual([]);
            expect(client.state!.voteResults).toBeNull();
        }

        // A dead player's vote is dropped silently: no snapshot, no error, no change at all.
        const before = JSON.stringify(corpse.state);
        corpse.socket.emit('vote', { gameId: t.gameId, voteTargetUUID: p1.playerUUID });
        await expectNoSnapshot(
            corpse,
            (s) =>
                s.myVoteTargetUUID !== null ||
                s.lynchDone ||
                (s.voteProgress?.voted ?? 0) !== 0,
            'the corpse vote',
        );
        expect(corpse.errors, 'a corpse vote must not even be an error').toHaveLength(0);
        expect(JSON.stringify(corpse.state), 'the corpse vote changed the state').toBe(before);

        await castNominations(t, [
            [p3, p1],
            [p4, p2],
            [p1, false],
            [p2, false],
        ]);
        await t.manager.waitFor((s) => s.nominationsFinished, 'the trial opened');

        await castVotes(t, [[p1, p1]]);
        let seen = await t.manager.waitFor((s) => s.voteProgress?.voted === 1, 'one vote counted');
        expect(seen.voteProgress).toEqual({ voted: 1, total: 4 });
        expect(decided(seen), 'the table can see who has decided').toEqual([p1.playerUUID]);
        expect(seen.players.find((p) => p.playerUUID === p2.playerUUID), 'a ballot leaked into the roster')
            .not.toHaveProperty('voteTargetUUID');
        expect(seen.voteResults, 'a partial ballot must not be reported').toBeNull();

        await castVotes(t, [[p2, p1]]);
        seen = await t.manager.waitFor((s) => s.voteProgress?.voted === 2, 'two votes counted');
        expect(seen.voteProgress).toEqual({ voted: 2, total: 4 });
        expect(decided(seen)).toEqual([p1.playerUUID, p2.playerUUID].sort());
        expect(seen.voteResults).toBeNull();

        await castVotes(t, [[p3, p2]]);
        seen = await t.manager.waitFor((s) => s.voteProgress?.voted === 3, 'three votes counted');
        expect(seen.voteProgress).toEqual({ voted: 3, total: 4 });
        expect(decided(seen)).toEqual([p1.playerUUID, p2.playerUUID, p3.playerUUID].sort());
        expect(seen.voteResults, 'the ballot is still open').toBeNull();

        await castVotes(t, [[p4, p1]]);
        await waitForLynch(t);

        for (const client of t.clients) {
            const state = client.state!;
            expect(state.votedOutUUID, `${name(client)}: p1 wins 3-1`).toBe(p1.playerUUID);
            const results = state.voteResults;
            expect(results, `${name(client)}: the finished ballot is reported`).not.toBeNull();
            expect(Object.keys(results!).sort(), `${name(client)}: every player is in the ballot`).toEqual(
                state.players.map((p) => p.playerUUID).sort(),
            );
            expect(results![p1.playerUUID!]).toBe(p1.playerUUID);
            expect(results![p2.playerUUID!]).toBe(p1.playerUUID);
            expect(results![p3.playerUUID!]).toBe(p2.playerUUID);
            expect(results![p4.playerUUID!]).toBe(p1.playerUUID);
            expect(results![corpse.playerUUID!], 'the corpse never voted').toBeNull();
            // After the lynch the corpse count grew by one: the tally only ever holds the living.
            expect(state.voteProgress).toEqual({ voted: 3, total: 3 });
        }

        t.expectNoErrors();
    });
});

describe('voting: the lynch itself', () => {
    it('17. clears the badge of a lynched sheriff and loses the tie-break for good', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);
        await firstNightAndElection(t);

        const start = livingClients(t);
        // A village role holds the badge, so the lynch cannot accidentally end the game.
        const sheriff = start.find((c) => c.state?.role !== Role.WEREWOLF)!;
        const runnerUp = start.find((c) => c !== sheriff && c.state?.role !== Role.WEREWOLF) ?? start.find((c) => c !== sheriff)!;
        await electSheriff(t, sheriff, runnerUp);

        const living = livingClients(t);
        const nominator = living.find((c) => c !== sheriff)!;
        await castNominations(
            t,
            living.map((c) => [c, c === nominator ? sheriff : false] as [Client, Client | false]),
        );
        // The sheriff does not vote for itself, but it must still cast a ballot or the trial never ends.
        await castVotes(
            t,
            living.map((c) => [c, c === sheriff ? false : sheriff] as [Client, Client | false]),
        );
        await waitForLynch(t);

        for (const client of t.clients) {
            const state = client.state!;
            expect(state.votedOutUUID).toBe(sheriff.playerUUID);
            expect(state.players.find((p) => p.playerUUID === sheriff.playerUUID)?.isAlive).toBe(false);
            expect(state.players.filter((p) => p.isSheriff), `${name(client)}: the badge died with them`).toHaveLength(0);
        }
        forEachSnapshot(t, (s) => s.lynchDone, (s, where) => {
            expect(s.players.filter((p) => p.isSheriff), `${where}: the badge stayed on a lynched sheriff`).toHaveLength(0);
        });

        await readyEveryone(t);
        const wolves = livingClients(t).filter((c) => c.state?.role === Role.WEREWOLF);
        const survivors = livingClients(t).filter((c) => c.state?.role !== Role.WEREWOLF);
        expect(wolves).toHaveLength(2);
        await playNight(t, { wolfTargets: wolves.map(() => survivors[0]!) });
        await t.waitForPhaseEverywhere(Phase.DAY);

        const alive = livingClients(t);
        expect(alive, 'the death count before the second day').toHaveLength(3);
        for (const client of t.clients) {
            expect(client.state!.players.filter((p) => p.isSheriff), `${name(client)}: a badge came back`).toHaveLength(0);
        }

        // A 1-1 tie in a three player day: with the badge gone nobody can break it.
        const [x, y, z] = alive as [Client, Client, Client];
        await castNominations(t, [
            [x, y],
            [y, x],
            [z, false],
        ]);
        await castVotes(t, [
            [x, y],
            [y, x],
            [z, false],
        ]);
        await waitForLynch(t);

        for (const client of t.clients) {
            const state = client.state!;
            expect(state.votedOutUUID, `${name(client)}: with no sheriff the tie kills nobody`).toBeNull();
            expect(state.players.filter((p) => p.isAlive), `${name(client)}: the tie killed somebody`).toHaveLength(3);
        }

        t.expectNoErrors();
    });

    it('18. takes the lover of a lynched player down with them', async () => {
        const t = await TestGame.create({ playerCount: 6 });
        game = t;
        await t.setupAndStart(SIX_LOVERS);

        const cupid = only(t, Role.CUPID);
        const seer = only(t, Role.SEER);
        const witch = only(t, Role.WITCH);
        const villager = only(t, Role.VILLAGER);
        const wolves = livingClients(t).filter((c) => c.state?.role === Role.WEREWOLF);
        expect(wolves).toHaveLength(2);

        // Deathless night: the pack splits, and the couple is a village pair.
        await playNight(t, { lovers: [seer, witch], wolfTargets: [cupid, villager] });
        await t.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);
        await skipElection(t);
        expect(livingClients(t)).toHaveLength(6);

        const living = livingClients(t);
        const nominator = living.find((c) => c !== seer)!;
        await castNominations(
            t,
            living.map((c) => [c, c === nominator ? seer : false] as [Client, Client | false]),
        );
        await castVotes(
            t,
            living.map((c) => [c, c === seer ? false : seer] as [Client, Client | false]),
        );
        await waitForLynch(t);

        for (const client of t.clients) {
            const state = client.state!;
            expect(state.votedOutUUID).toBe(seer.playerUUID);
            expect(state.players.find((p) => p.playerUUID === seer.playerUUID)?.isAlive).toBe(false);
            expect(
                state.players.find((p) => p.playerUUID === witch.playerUUID)?.isAlive,
                `${name(client)}: the lover was never on the ballot but must die`,
            ).toBe(false);
        }
        expect(t.aliveClients(), 'four players remain').toHaveLength(4);
        expect(t.manager.state!.phase, 'the game continues').toBe(Phase.DAY);
        expect(witch.state!.lovePartnerUUID).toBe(seer.playerUUID);
        // Negative space: the ballot itself only ever named the seer.
        forEachSnapshot(t, (s) => s.lynchDone, (s, where) => {
            expect(s.votedOutUUID, `${where}: the ballot silently included the lover`).toBe(seer.playerUUID);
        });

        t.expectNoErrors();
    });

    it('19. ends the game the moment the last werewolf is lynched', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE_ONE_WOLF);

        const wolf = only(t, Role.WEREWOLF);
        const villager = livingClients(t).find((c) => c.state?.role === Role.VILLAGER)!;
        // The single wolf cannot split, so the witch keeps the village at full strength.
        await playNight(t, { wolfTargets: [villager], heal: true });
        await t.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);
        await skipElection(t);
        expect(livingClients(t)).toHaveLength(5);

        const living = livingClients(t);
        const nominator = living.find((c) => c !== wolf)!;
        await castNominations(
            t,
            living.map((c) => [c, c === nominator ? wolf : false] as [Client, Client | false]),
        );
        await castVotes(
            t,
            living.map((c) => [c, c === wolf ? false : wolf] as [Client, Client | false]),
        );

        await t.waitForPhaseEverywhere(Phase.GAME_OVER);
        for (const client of t.clients) {
            const state = client.state!;
            expect(state.phase, `${name(client)} phase`).toBe(Phase.GAME_OVER);
            expect(state.winningTeam, `${name(client)} winning team`).toBe('village');
            expect(state.votedOutUUID).toBe(wolf.playerUUID);
            expect(state.players.find((p) => p.playerUUID === wolf.playerUUID)?.isAlive).toBe(false);
        }

        // Immediately: no snapshot ever shows the lynch resolved while the game is still a day.
        forEachSnapshot(t, (s) => s.phase === Phase.DAY, (s, where) => {
            expect(s.lynchDone, `${where}: the day resolved the last wolf without ending the game`).toBe(false);
        });
        forEachSnapshot(t, (s) => s.votedOutUUID === wolf.playerUUID, (s, where) => {
            expect(s.phase, `${where}: the wolf lynch was not the end of the game`).toBe(Phase.GAME_OVER);
        });

        t.expectNoErrors();
    });

    it('20. buries the lynched witch\'s untouched potions: the next night has nobody to heal', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);
        await reachDay(t);

        const witch = only(t, Role.WITCH);
        expect(witch.state!.witchUsedHealingPotion).toBe(false);
        expect(witch.state!.witchUsedKillingPotion).toBe(false);

        const living = livingClients(t);
        const nominator = living.find((c) => c !== witch)!;
        await castNominations(
            t,
            living.map((c) => [c, c === nominator ? witch : false] as [Client, Client | false]),
        );
        await castVotes(
            t,
            living.map((c) => [c, c === witch ? false : witch] as [Client, Client | false]),
        );
        await waitForLynch(t);
        expect(t.aliveClients()).toHaveLength(4);

        // The potions were never used and die with her.
        expect(witch.state!.players.find((p) => p.playerUUID === witch.playerUUID)?.isAlive).toBe(false);
        expect(witch.state!.witchUsedHealingPotion, 'a corpse cannot have used a potion').toBe(false);
        expect(witch.state!.witchUsedKillingPotion).toBe(false);

        await readyEveryone(t);
        const wolves = livingClients(t).filter((c) => c.state?.role === Role.WEREWOLF);
        const villager = livingClients(t).find((c) => c.state?.role === Role.VILLAGER)!;
        const woke = await playNight(t, { wolfTargets: wolves.map(() => villager) });
        expect(woke, 'a dead witch must not get a turn').not.toContain(Role.WITCH);

        await t.waitForPhaseEverywhere(Phase.DAY);
        for (const client of t.clients) {
            const state = client.state!;
            expect(
                state.players.find((p) => p.playerUUID === villager.playerUUID)?.isAlive,
                `${name(client)}: nobody was left to heal the ordered kill`,
            ).toBe(false);
            expect(state.players.filter((p) => p.isAlive)).toHaveLength(3);
        }

        t.expectNoErrors();
    });
});

describe('voting: day structure', () => {
    it('21. rejects readyForNight before the lynch and again inside the night', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);
        await reachDay(t);

        const living = livingClients(t);
        const candidate = living[0]!;
        const nominator = living[1]!;
        const early = living[2]!;
        await castNominations(
            t,
            living.map((c) => [c, c === nominator ? candidate : false] as [Client, Client | false]),
        );
        await t.manager.waitFor((s) => s.nominationsFinished, 'the trial opened');
        expect(t.manager.state!.lynchDone).toBe(false);

        // BUGS.md B12: confirming before the lynch resolved used to end the day with no result.
        const tooEarly = await rejected(
            early,
            'readyForNight',
            { gameId: t.gameId },
            'ready for night before the lynch',
        );
        expect(tooEarly).toMatch(/not resolved the lynch/i);
        expect(early.state!.readyForNight).toBe(false);
        expect(early.state!.phase).toBe(Phase.DAY);
        expect(early.state!.lynchDone, 'the rejected confirm resolved the day').toBe(false);

        await castVotes(
            t,
            living.map((c) => [c, candidate] as [Client, Client | false]),
        );
        await waitForLynch(t);

        // ...and after the result the very same request is accepted.
        early.socket.emit('readyForNight', { gameId: t.gameId });
        await early.waitFor((s) => s.readyForNight, 'the confirm after the lynch');

        // The confirmation is public participation: another phone can name the one that
        // already tapped, without being told anything about what anyone chose.
        const watcher = livingClients(t).find((c) => c !== early)!;
        await watcher.waitFor(
            (s) => s.players.find((p) => p.playerUUID === early.playerUUID)?.readyForNight === true,
            'the ready flag is public',
        );

        await readyEveryone(t);
        for (const client of t.clients) {
            expect(client.state!.phase).toBe(Phase.NIGHT);
            expect(client.state!.readyForNight, `${name(client)}: the ready flag survived into the night`).toBe(
                false,
            );
        }

        // A day cannot be re-entered from inside the night.
        const inNight = await rejected(
            early,
            'readyForNight',
            { gameId: t.gameId },
            'ready for night during the night',
        );
        expect(inNight).toMatch(/not currently in day phase/i);
        expect(early.errors).toHaveLength(2);
    });

    it('22. needs only the living for ready, and resets every flag on the next night', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);
        await reachDay(t);

        const living = livingClients(t);
        const candidate = living[0]!;
        const nominator = living[1]!;
        await castNominations(
            t,
            living.map((c) => [c, c === nominator ? candidate : false] as [Client, Client | false]),
        );
        await castVotes(
            t,
            living.map((c) => [c, candidate] as [Client, Client | false]),
        );
        await waitForLynch(t);

        const remaining = livingClients(t);
        expect(remaining).toHaveLength(4);

        // A corpse is not asked and is not counted.
        candidate.socket.emit('readyForNight', { gameId: t.gameId });
        await expectNoSnapshot(
            candidate,
            (s) => s.readyForNight || s.phase !== Phase.DAY,
            'the corpse confirm',
        );
        expect(candidate.state!.readyForNight).toBe(false);

        const [r1, r2, r3, silent] = remaining as [Client, Client, Client, Client];
        for (const client of [r1, r2, r3]) {
            client.socket.emit('readyForNight', { gameId: t.gameId });
            await client.waitFor((s) => s.readyForNight, `the confirm of ${client.playerUUID}`);
        }
        for (const client of t.clients) {
            expect(client.state!.phase, `${name(client)}: three of four is not enough`).toBe(Phase.DAY);
        }
        expect(silent.state!.readyForNight).toBe(false);

        // Readiness is public: the phone that has not tapped can see that it is the last
        // one missing, and every other phone sees the same three names.
        const confirmed = [r1.playerUUID!, r2.playerUUID!, r3.playerUUID!].sort();
        await Promise.all(
            t.clients.map((c) =>
                c.waitFor(
                    (s) => s.players.filter((p) => p.isAlive && p.readyForNight).length === 3,
                    'everyone sees who has confirmed',
                ),
            ),
        );
        for (const client of t.clients) {
            const publiclyReady = client
                .state!.players.filter((p) => p.isAlive && p.readyForNight)
                .map((p) => p.playerUUID)
                .sort();
            expect(publiclyReady, `${name(client)}: the roster hides who has confirmed`).toEqual(confirmed);
            expect(
                client.state!.players.find((p) => p.playerUUID === silent.playerUUID)?.readyForNight,
                `${name(client)}: the missing phone is named`,
            ).toBe(false);
        }

        silent.socket.emit('readyForNight', { gameId: t.gameId });
        await t.waitForPhaseEverywhere(Phase.NIGHT);

        for (const client of t.clients) {
            expect(client.state!.readyForNight, `${name(client)}: the ready flag was not reset`).toBe(false);
        }

        t.expectNoErrors();
    });
});

describe('voting: election ordering', () => {
    it('23. rejects accepting before the election resolved and again after it was accepted', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);
        await playNight(t, { wolfTargets: splitVotes(t) });
        await t.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);

        const living = livingClients(t);
        const sheriff = living[0]!;
        const runnerUp = living[1]!;

        const early = await rejected(
            sheriff,
            'acceptSheriffRole',
            { gameId: t.gameId },
            'accepting before the election resolved',
        );
        expect(early).toMatch(/not resolved yet/i);
        expect(sheriff.state!.sheriffElectionDone).toBe(false);
        expect(sheriff.state!.phase).toBe(Phase.SHERIFF_ELECTION);

        await electSheriff(t, sheriff, runnerUp);
        expect(t.manager.state!.phase).toBe(Phase.DAY);

        const twice = await rejected(
            sheriff,
            'acceptSheriffRole',
            { gameId: t.gameId },
            'accepting the badge twice',
        );
        expect(twice).toMatch(/not in sheriff_election phase/i);
        expect(sheriff.errors).toHaveLength(2);

        for (const client of t.clients) {
            expect(client.state!.phase, `${name(client)}: the second accept advanced the day`).toBe(Phase.DAY);
            expect(client.state!.players.filter((p) => p.isSheriff).map((p) => p.playerUUID)).toEqual([
                sheriff.playerUUID,
            ]);
        }
    });

    it('24. never holds a second sheriff election after night 1', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);
        await reachDay(t);

        const living = livingClients(t);
        const victim = living.find((c) => c.state?.role !== Role.WEREWOLF)!;
        const nominator = living.find((c) => c !== victim)!;
        await castNominations(
            t,
            living.map((c) => [c, c === nominator ? victim : false] as [Client, Client | false]),
        );
        await castVotes(
            t,
            living.map((c) => [c, c === victim ? false : victim] as [Client, Client | false]),
        );
        await waitForLynch(t);

        await readyEveryone(t);
        const wolves = livingClients(t).filter((c) => c.state?.role === Role.WEREWOLF);
        const prey = livingClients(t).find((c) => c.state?.role !== Role.WEREWOLF)!;
        await playNight(t, { wolfTargets: wolves.map(() => prey) });
        await t.waitForPhaseEverywhere(Phase.DAY);

        for (const client of t.clients) {
            const state = client.state!;
            expect(state.phase, `${name(client)}: dawn of night 1 is a day`).toBe(Phase.DAY);
            expect(state.sheriffElectionDone, 'the round-0 election stays done').toBe(true);
            expect(state.lynchDone, 'the new day starts without a lynch').toBe(false);
            expect(
                candidatesIn(state),
                `${name(client)}: nominations open fresh`,
            ).toHaveLength(0);
        }

        // The election screen is gone for good: accepting now is a phase error.
        const late = livingClients(t)[0]!;
        const error = await rejected(
            late,
            'acceptSheriffRole',
            { gameId: t.gameId },
            'accepting a badge on the second day',
        );
        expect(error).toMatch(/not in sheriff_election phase/i);

        for (const client of t.clients) {
            const firstDay = client.history.findIndex((s) => s.phase === Phase.DAY);
            expect(firstDay, `${name(client)} never saw a day`).toBeGreaterThan(-1);
            expect(
                client.history.slice(firstDay).filter((s) => s.phase === Phase.SHERIFF_ELECTION),
                `${name(client)} was sent back to a sheriff election`,
            ).toHaveLength(0);
        }

        expect(late.errors).toHaveLength(1);
    });
});

describe('voting: GM force advance', () => {
    it('25. advances exactly from open nominations to the trial, and a normal vote then works', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);
        await reachDay(t);

        const living = livingClients(t);
        const candidate = living[0]!;
        const nominator = living[1]!;
        const silent = living[2]!;
        await castNominations(t, [[nominator, candidate]]);
        expect(t.manager.state!.nominationsFinished).toBe(false);

        const trial = await advanceManager(t, (s) => s.nominationsFinished, 'the GM closes the nominations');
        expect(trial.phase, 'one step is the trial, not the night').toBe(Phase.DAY);
        expect(trial.lynchDone, 'the GM resolved the lynch as well').toBe(false);
        expect(trial.votedOutUUID).toBeNull();
        expect(trial.voteProgress).toEqual({ voted: 0, total: 5 });
        expect(trial.players.find((p) => p.playerUUID === silent.playerUUID)?.nomination, 'the abstain is explicit').toBe(
            false,
        );

        // A normal action still works in the stage the GM opened.
        await castVotes(
            t,
            living.map((c) => [c, candidate] as [Client, Client | false]),
        );
        await waitForLynch(t);
        expect(t.manager.state!.votedOutUUID, 'the trial opened by the GM resolved normally').toBe(
            candidate.playerUUID,
        );

        t.expectNoErrors();
    });

    it('26. advances exactly from an open trial to the result, and ready then works', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);
        await reachDay(t);

        const living = livingClients(t);
        const candidate = living[0]!;
        const nominator = living[1]!;
        await castNominations(
            t,
            living.map((c) => [c, c === nominator ? candidate : false] as [Client, Client | false]),
        );
        await t.manager.waitFor((s) => s.nominationsFinished, 'the trial opened');

        await castVotes(t, [
            [living[1]!, candidate],
            [living[2]!, candidate],
        ]);
        await t.manager.waitFor((s) => s.voteProgress?.voted === 2, 'two of five votes landed');

        const result = await advanceManager(t, (s) => s.lynchDone, 'the GM closes the trial');
        expect(result.phase, 'one step is the result screen, not the night').toBe(Phase.DAY);
        expect(result.votedOutUUID, 'the two real votes outnumber the filled abstains').toBe(candidate.playerUUID);
        expect(result.players.find((p) => p.playerUUID === candidate.playerUUID)?.isAlive).toBe(false);

        // A normal action still works from the result screen.
        await readyEveryone(t);
        expect(t.manager.state!.phase).toBe(Phase.NIGHT);
        expect(t.manager.state!.lynchDone, 'the night reset the lynch flag').toBe(false);

        t.expectNoErrors();
    });

    it('27. advances exactly from the result screen into the night, and a normal night action works', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);
        await reachDay(t);

        await nominateEveryone(t, () => false);
        await waitForLynch(t);
        expect(t.manager.state!.votedOutUUID).toBeNull();

        const night = await advanceManager(t, (s) => s.phase === Phase.NIGHT, 'the GM starts the night');
        expect(night.lynchDone, 'the night resets the lynch flag').toBe(false);
        expect(night.activeNightRole, 'the night starts at its first waking role').toBe(Role.WEREWOLF);
        expect(night.players.every((p) => p.isAlive), 'nobody died on the way into the night').toBe(true);
        for (const client of t.clients) {
            expect(client.state!.readyForNight, `${name(client)}: the ready flag was not reset`).toBe(false);
        }

        // A normal night action works and advances exactly one sub-turn, not into dawn.
        const wolves = livingClients(t).filter((c) => c.state?.role === Role.WEREWOLF);
        const target = only(t, Role.SEER);
        for (const wolf of wolves) {
            wolf.socket.emit('werewolfVote', { gameId: t.gameId, targetUUID: target.playerUUID });
        }
        await Promise.all(t.clients.map((c) => c.waitForTurn(Role.SEER)));
        for (const client of t.clients) {
            expect(client.state!.phase).toBe(Phase.NIGHT);
            expect(client.state!.activeNightRole).toBe(Role.SEER);
            expect(client.state!.players.every((p) => p.isAlive), 'the night ended early').toBe(true);
        }

        t.expectNoErrors();
    });

    it('28. advances exactly from an unresolved election to the badge, then to the day', async () => {
        const t = await TestGame.create({ playerCount: 5 });
        game = t;
        await t.setupAndStart(FIVE);
        await firstNightAndElection(t);

        const [candidate, nominator, v2, v3, silent] = livingClients(t) as [
            Client,
            Client,
            Client,
            Client,
            Client,
        ];
        // The direct ballot is only half filled when the GM steps in: no nomination stage exists.
        await castVotes(t, [
            [nominator, candidate],
            [v2, candidate],
            [v3, candidate],
        ]);
        expect(silent.state!.myVoteTargetUUID, 'the last voter stays silent').toBeNull();

        const elected = await advanceManager(t, (s) => s.sheriffElectionDone, 'the GM closes the election');
        expect(elected.phase, 'one step is the elected badge, not the day').toBe(Phase.SHERIFF_ELECTION);
        expect(elected.players.filter((p) => p.isSheriff).map((p) => p.playerUUID)).toEqual([
            candidate.playerUUID,
        ]);
        await Promise.all(
            t.clients.map((c) => c.waitFor((s) => s.players.some((p) => p.isSheriff), 'the badge everywhere')),
        );

        const day = await advanceManager(t, (s) => s.phase === Phase.DAY, 'the GM opens the day');
        expect(day.sheriffElectionDone).toBe(true);
        expect(day.players.filter((p) => p.isSheriff).map((p) => p.playerUUID)).toEqual([
            candidate.playerUUID,
        ]);

        // A normal action still works on the day the GM opened.
        await castNominations(t, [[nominator, candidate]]);
        expect(candidatesIn(t.manager.state!), 'the day accepted a nomination').toContain(candidate.playerUUID);

        t.expectNoErrors();
    });
});
