import { describe, it, expect, afterEach } from 'vitest';
import { Client, TestGame } from './harness.js';
import type { Snapshot } from './harness.js';
import { Phase } from '@shared/phases.js';
import { Role } from '@shared/roles.js';

// The sheriff is elected by a direct vote. There is no nomination stage: every living
// player is a candidate from the first snapshot, and the badge goes to the plurality.
// These tests pin that contract on real sockets, including what is deliberately different
// from the daily lynch (nominate is a DAY-only event, a tie elects nobody).

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

const aliveClients = (g: TestGame): Client[] =>
    connected(g).filter((c) => c.state!.players.find((p) => p.playerUUID === c.playerUUID)?.isAlive);

async function waitForTurnEverywhere(g: TestGame, role: string): Promise<void> {
    await Promise.all(connected(g).map((c) => c.waitForTurn(role)));
}

/** Plays night 0 (the wolves kill a villager, the seer peeks, the witch does nothing). */
async function reachSheriffElection(g: TestGame): Promise<Client> {
    await waitForTurnEverywhere(g, Role.WEREWOLF);

    const wolves = g.clientsWithRole(Role.WEREWOLF);
    const victim = g.clientsWithRole(Role.VILLAGER)[0]!;
    for (const wolf of wolves) {
        wolf.socket.emit('werewolfVote', { gameId: g.gameId, targetUUID: victim.playerUUID });
    }

    await waitForTurnEverywhere(g, Role.SEER);
    const seer = g.clientsWithRole(Role.SEER)[0]!;
    const peek = connected(g).find((c) => c !== seer && aliveClients(g).includes(c))!;
    seer.socket.emit('revealRole', { gameId: g.gameId, revealUUID: peek.playerUUID });
    await seer.waitFor((s) => s.seerRevealUUID === peek.playerUUID, 'seer saw the role');
    seer.socket.emit('seerConfirmed', { gameId: g.gameId });

    await waitForTurnEverywhere(g, Role.WITCH);
    g.clientsWithRole(Role.WITCH)[0]!.socket.emit('witchConfirms', { gameId: g.gameId });

    await g.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);
    return victim;
}

async function emitExpectError(client: Client, event: string, payload: unknown, label: string): Promise<string> {
    const wait = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for an error after "${label}"`)), 2000);
        client.socket.once('error', (data: { message: string }) => {
            clearTimeout(timer);
            resolve(data.message);
        });
    });
    client.socket.emit(event, payload);
    return wait;
}

/** Casts one ballot and waits until the caster's own snapshot shows it (or the result). */
async function castVote(client: Client, target: string | false): Promise<Snapshot> {
    client.socket.emit('vote', { gameId: game!.gameId, voteTargetUUID: target });
    return client.waitFor(
        (s) => s.sheriffElectionDone || s.myVoteTargetUUID === target,
        `ballot ${target === false ? 'abstain' : target} accepted`,
    );
}

describe('sheriff election: direct vote', () => {
    it('elects a sheriff without any nomination stage', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(NIGHT_ROLES);
        const victim = await reachSheriffElection(game);

        // The victim died, so five players vote and all living players are candidates.
        const voters = aliveClients(game);
        expect(voters).toHaveLength(5);
        expect(voters.some((c) => c.playerUUID === victim.playerUUID)).toBe(false);

        const winner = voters[0]!;
        for (const voter of voters) {
            await castVote(voter, winner.playerUUID!);
        }

        await Promise.all(voters.map((c) => c.waitFor((s) => s.sheriffElectionDone, 'election resolved')));

        const result = voters[0]!.state!;
        expect(result.sheriffElectionDone).toBe(true);
        expect(result.players.find((p) => p.isSheriff)?.playerUUID).toBe(winner.playerUUID);
        // The whole ballot is reported once everyone has voted.
        expect(Object.values(result.voteResults ?? {})).toContain(winner.playerUUID);

        // The elected sheriff accepts the badge.
        winner.socket.emit('acceptSheriffRole', { gameId: game.gameId });
        await winner.waitForPhase(Phase.DAY);
        await game.waitForPhaseEverywhere(Phase.DAY);
        expect(winner.state!.players.find((p) => p.isSheriff)?.playerUUID).toBe(winner.playerUUID);
        game.expectNoErrors();
    });

    it('lets every living player vote immediately, including for themselves', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(NIGHT_ROLES);
        await reachSheriffElection(game);

        const selfVoter = aliveClients(game)[0]!;
        const snapshot = await castVote(selfVoter, selfVoter.playerUUID!);
        expect(snapshot.myVoteTargetUUID).toBe(selfVoter.playerUUID);
        // One ballot in, four still outstanding - nothing resolves early.
        expect(snapshot.sheriffElectionDone).toBe(false);
        expect(snapshot.voteProgress?.voted).toBe(1);

        game.expectNoErrors();
    });

    it('rejects nominating anyone during the election', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(NIGHT_ROLES);
        await reachSheriffElection(game);

        const voter = aliveClients(game)[0]!;
        const target = aliveClients(game)[1]!;
        const message = await emitExpectError(
            voter,
            'nominate',
            { gameId: game.gameId, nominationUUID: target.playerUUID },
            'nominate during the election',
        );
        expect(message).toMatch(/Nominations are closed/i);
        expect(voter.state!.myNominationUUID).toBeNull();
        expect(voter.state!.sheriffElectionDone).toBe(false);
    });

    it('rejects a vote for a corpse or for a player who is not in the game', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(NIGHT_ROLES);
        const victim = await reachSheriffElection(game);

        const voter = aliveClients(game)[0]!;
        const deadMessage = await emitExpectError(
            voter,
            'vote',
            { gameId: game.gameId, voteTargetUUID: victim.playerUUID },
            'vote for a corpse',
        );
        expect(deadMessage).toMatch(/not available/i);

        const ghostMessage = await emitExpectError(
            voter,
            'vote',
            { gameId: game.gameId, voteTargetUUID: '11111111-1111-4111-8111-111111111111' },
            'vote for an unknown player',
        );
        expect(ghostMessage).toMatch(/not available/i);

        expect(voter.state!.myVoteTargetUUID).toBeNull();
        expect(voter.state!.sheriffElectionDone).toBe(false);
    });

    it('ignores a ballot from a dead player', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(NIGHT_ROLES);
        const victim = await reachSheriffElection(game);

        // The `victim` client is dead but still connected; its vote is silently dropped.
        const before = victim.history.length;
        victim.socket.emit('vote', { gameId: game.gameId, voteTargetUUID: aliveClients(game)[0]!.playerUUID });
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(victim.history.length).toBe(before);
        expect(victim.errors).toHaveLength(0);
        expect(aliveClients(game)[0]!.state!.voteProgress?.voted).toBe(0);
    });

    it('elects nobody on a tie and lets the game master open the day', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(NIGHT_ROLES);
        await reachSheriffElection(game);

        const voters = aliveClients(game);
        const [a, b, ...rest] = voters;
        // Direct votes: 2 - 2 - 1 (the last voter abstains) -> no unique winner.
        await castVote(a!, a!.playerUUID!);
        await castVote(b!, b!.playerUUID!);
        await castVote(rest[0]!, a!.playerUUID!);
        await castVote(rest[1]!, b!.playerUUID!);
        await castVote(rest[2]!, false);

        await Promise.all(voters.map((c) => c.waitFor((s) => s.sheriffElectionDone, 'tie resolved')));
        const result = voters[0]!.state!;
        expect(result.sheriffElectionDone).toBe(true);
        expect(result.players.some((p) => p.isSheriff)).toBe(false);

        // Only the GM can move the day on when nobody wears the badge.
        await expect(
            emitExpectError(voters.find((c) => !c.state!.isManager)!, 'acceptSheriffRole', { gameId: game.gameId }, 'non-GM continues'),
        ).resolves.toMatch(/Only GM|not the elected sheriff/i);

        game.manager.socket.emit('acceptSheriffRole', { gameId: game.gameId });
        await game.waitForPhaseEverywhere(Phase.DAY);
    });

    it('elects nobody when every living player abstains', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(NIGHT_ROLES);
        await reachSheriffElection(game);

        const voters = aliveClients(game);
        for (const voter of voters) await castVote(voter, false);

        await Promise.all(voters.map((c) => c.waitFor((s) => s.sheriffElectionDone, 'abstain-only election resolved')));
        const result = voters[0]!.state!;
        expect(result.players.some((p) => p.isSheriff)).toBe(false);
        // Every living player's ballot is an explicit abstain; the corpse has no ballot.
        const livingBallots = result.players
            .filter((p) => p.isAlive)
            .map((p) => result.voteResults?.[p.playerUUID]);
        expect(livingBallots).toEqual([false, false, false, false, false]);
        game.expectNoErrors();
    });

    it('resolves an open election in one force-advance step', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(NIGHT_ROLES);
        await reachSheriffElection(game);

        const voters = aliveClients(game);
        // Only one ballot was cast; the GM's escape hatch fills the rest as abstains.
        await castVote(voters[0]!, voters[0]!.playerUUID!);
        game.manager.socket.emit('managerAdvance', { gameId: game.gameId });

        await Promise.all(voters.map((c) => c.waitFor((s) => s.sheriffElectionDone, 'escape hatch resolved the election')));
        expect(voters[0]!.state!.players.find((p) => p.isSheriff)?.playerUUID).toBe(voters[0]!.playerUUID);
        // Exactly one stage: still in SHERIFF_ELECTION waiting for the badge to be accepted.
        expect(voters[0]!.state!.phase).toBe(Phase.SHERIFF_ELECTION);

        game.manager.socket.emit('managerAdvance', { gameId: game.gameId });
        await game.waitForPhaseEverywhere(Phase.DAY);
        game.expectNoErrors();
    });
});
