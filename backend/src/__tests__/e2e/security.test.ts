import { describe, it, expect, afterEach } from 'vitest';
import { Client, TestGame } from './harness.js';
import type { Snapshot } from './harness.js';
import { Phase } from '@shared/phases.js';
import { Role } from '@shared/roles.js';

// Authorization, action validation and snapshot privacy over real sockets.
// See BUGS.md WP1 (identity), WP2 (validation) and the "snapshot audiences" table.
//
// Roles are assigned randomly, so every test discovers them from the snapshots it
// receives. The role compositions below only fix *which* roles exist, never who has them.

// 6 players: every night role including the first-night-only Cupid.
const FULL_ROLES: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.SEER]: 1,
    [Role.WITCH]: 1,
    [Role.CUPID]: 1,
    [Role.VILLAGER]: 1,
};

// 6 players: a night order of Werewolf -> Seer -> Witch, no Cupid.
const NIGHT_ROLES: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.SEER]: 1,
    [Role.WITCH]: 1,
    [Role.VILLAGER]: 2,
};

// 6 players: the smallest composition that still lets a lynch happen without Cupid/Witch.
const LYNCH_ROLES: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.SEER]: 1,
    [Role.VILLAGER]: 3,
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

/** Uses the GM escape hatch once per remaining night sub-turn until dawn. */
async function advanceNightToDawn(g: TestGame): Promise<void> {
    let guard = 0;
    while (g.manager.state!.phase === Phase.NIGHT) {
        guard += 1;
        if (guard > 10) throw new Error('night did not end after ten managerAdvance calls');
        const role = g.manager.state!.activeNightRole;
        await advanceManager(
            g,
            (s) => s.phase !== Phase.NIGHT || s.activeNightRole !== role,
            'night escape hatch step',
        );
    }
}

/**
 * Emits a deliberately rejected event and resolves with the server's error message.
 * The harness listener records it in `client.errors` first, so the count is already
 * updated when this promise resolves.
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

/** Asserts that `predicate` never becomes true within `ms` (for "nothing happened" checks). */
async function expectNoChange(
    client: Client,
    predicate: (s: Snapshot) => boolean,
    label: string,
    ms = 500,
): Promise<void> {
    await expect(client.waitFor(predicate, label, ms)).rejects.toThrow(/Timed out/);
}

describe('security: manager-only lobby actions', () => {
    it('rejects closeJoining, roleDistribution and startGame from a non-manager', async () => {
        game = await TestGame.create({ playerCount: 6 });
        const nonManager = game.clients[1]!;

        await emitExpectError(nonManager, 'closeJoining', { gameId: game.gameId }, 'non-manager closeJoining');
        for (const c of connected(game)) {
            expect(c.state!.phase).toBe(Phase.LOBBY);
            expect(c.state!.role).toBeNull();
            expect(c.state!.players.every((p) => p.role === null)).toBe(true);
        }

        await emitExpectError(
            nonManager,
            'roleDistribution',
            { gameId: game.gameId, roles: FULL_ROLES },
            'non-manager roleDistribution',
        );
        for (const c of connected(game)) {
            expect(c.state!.phase).toBe(Phase.LOBBY);
            expect(c.state!.players.every((p) => p.role === null)).toBe(true);
        }

        await emitExpectError(nonManager, 'startGame', { gameId: game.gameId }, 'non-manager startGame');
        for (const c of connected(game)) {
            expect(c.state!.phase).toBe(Phase.LOBBY);
            expect(c.state!.players.every((p) => p.role === null)).toBe(true);
        }
        expect(nonManager.errors).toHaveLength(3);

        // The same three calls from the real manager succeed.
        const roleSelection = connected(game).map((c) => c.waitForPhase(Phase.ROLE_SELECTION));
        game.manager.socket.emit('closeJoining', { gameId: game.gameId });
        await Promise.all(roleSelection);

        const distribution = connected(game).map((c) => c.waitForPhase(Phase.DISTRIBUTION));
        game.manager.socket.emit('roleDistribution', { gameId: game.gameId, roles: FULL_ROLES });
        await Promise.all(distribution);

        const night = connected(game).map((c) => c.waitForPhase(Phase.NIGHT));
        game.manager.socket.emit('startGame', { gameId: game.gameId });
        await Promise.all(night);

        expect(game.clients.filter((c) => c.state!.role === Role.WEREWOLF)).toHaveLength(2);
        expect(game.clients.filter((c) => c.state!.role === Role.VILLAGER)).toHaveLength(1);
    });
});

describe('security: a socket that is not in the game', () => {
    it('rejects its lobby and vote events and never crashes the game', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(NIGHT_ROLES);
        await waitForTurnEverywhere(game, Role.WEREWOLF);

        const stranger = await Client.connect(game.server.url);
        try {
            await emitExpectError(stranger, 'closeJoining', { gameId: game.gameId }, 'stranger closeJoining');
            await emitExpectError(
                stranger,
                'vote',
                { gameId: game.gameId, voteTargetUUID: false },
                'stranger vote',
            );
            await emitExpectError(
                stranger,
                'joinGame',
                { gameId: game.gameId, playerUUID: null },
                'stranger joinGame after the lobby closed',
            );

            expect(stranger.state).toBeNull();
            expect(stranger.playerUUID).toBeNull();
            expect(stranger.errors).toHaveLength(3);

            for (const c of connected(game)) {
                expect(c.state!.players).toHaveLength(6);
                expect(c.state!.phase).toBe(Phase.NIGHT);
            }

            // The server survived the three rejected calls.
            const beforeRole = game.manager.state!.activeNightRole;
            await advanceManager(
                game,
                (s) => s.phase !== Phase.NIGHT || s.activeNightRole !== beforeRole,
                'game still advances after the stranger',
            );
        } finally {
            stranger.close();
        }

        game.expectNoErrors();
    });
});

describe('security: out-of-turn night action', () => {
    it('rejects the seer during the cupid turn and does not advance the night', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(FULL_ROLES);
        await waitForTurnEverywhere(game, Role.CUPID);

        const seer = game.clientsWithRole(Role.SEER)[0]!;
        const target = connected(game).find((c) => c !== seer)!;

        await emitExpectError(
            seer,
            'revealRole',
            { gameId: game.gameId, revealUUID: target.playerUUID },
            'seer reveals out of turn',
        );
        await emitExpectError(seer, 'seerConfirmed', { gameId: game.gameId }, 'seer confirms out of turn');

        // The exploit in B5 was that this walked the night to dawn with no deaths.
        for (const c of connected(game)) {
            expect(c.state!.phase).toBe(Phase.NIGHT);
            expect(c.state!.activeNightRole).toBe(Role.CUPID);
            expect(c.state!.players.every((p) => p.isAlive)).toBe(true);
        }
        expect(seer.state!.seerRevealUUID).toBeNull();
        expect(seer.state!.seerRevealRole).toBeNull();
        expect(seer.errors).toHaveLength(2);
    });
});

describe('security: dead players cannot act', () => {
    it('ignores every action from a lynched player', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(LYNCH_ROLES);
        await waitForTurnEverywhere(game, Role.WEREWOLF);

        // Empty night -> sheriff election -> day, all through the GM escape hatch.
        await advanceNightToDawn(game);
        await game.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);
        await advanceManager(game, (s) => s.sheriffElectionDone, 'sheriff election resolved');
        await advanceManager(game, (s) => s.phase === Phase.DAY, 'day');
        await Promise.all(connected(game).map((c) => c.waitForPhase(Phase.DAY)));

        // Lynch the seer: a villager, so the game cannot end on this lynch.
        const victim = game.clientsWithRole(Role.SEER)[0]!;
        const victimUUID = victim.playerUUID!;
        const voters = connected(game).filter(alive);
        const nominator = voters.find((c) => c !== victim)!;

        nominator.socket.emit('nominate', { gameId: game.gameId, nominationUUID: victimUUID });
        for (const c of voters) {
            if (c === nominator) continue;
            c.socket.emit('nominate', { gameId: game.gameId, nominationUUID: false });
        }
        await Promise.all(voters.map((c) => c.waitFor((s) => s.nominationsFinished, 'nominations finished')));

        for (const c of voters) {
            c.socket.emit('vote', { gameId: game.gameId, voteTargetUUID: victimUUID });
        }
        await Promise.all(
            connected(game).map((c) =>
                c.waitFor((s) => s.lynchDone && s.votedOutUUID === victimUUID, 'lynch resolved'),
            ),
        );
        await Promise.all(
            connected(game).map((c) =>
                c.waitFor(
                    (s) => s.players.find((p) => p.playerUUID === victimUUID)?.isAlive === false,
                    'victim is dead',
                ),
            ),
        );

        expect(victim.state!.phase).toBe(Phase.DAY);
        expect(victim.state!.activeNightRole).toBeNull();

        const before = JSON.stringify(victim.state);
        const errorsBefore = victim.errors.length;

        // A corpse must not nominate, vote, ready up, or use its night role.
        victim.socket.emit('nominate', { gameId: game.gameId, nominationUUID: false });
        victim.socket.emit('vote', { gameId: game.gameId, voteTargetUUID: false });
        victim.socket.emit('readyForNight', { gameId: game.gameId });
        victim.socket.emit('revealRole', { gameId: game.gameId, revealUUID: nominator.playerUUID });
        victim.socket.emit('seerConfirmed', { gameId: game.gameId });

        // Nothing at all may happen: no snapshot, no error, no phase change.
        await expectNoChange(
            victim,
            (s) =>
                s.phase !== Phase.DAY ||
                s.readyForNight ||
                s.seerRevealUUID !== null ||
                s.myVoteTargetUUID !== victimUUID,
            'dead player action',
        );

        expect(victim.errors.length).toBe(errorsBefore);
        expect(victim.state!.phase).toBe(Phase.DAY);
        expect(victim.state!.lynchDone).toBe(true);
        expect(victim.state!.activeNightRole).toBeNull();
        expect(victim.state!.seerRevealUUID).toBeNull();
        expect(JSON.stringify(victim.state)).toBe(before);

        for (const c of connected(game)) {
            expect(c.state!.phase).toBe(Phase.DAY);
            expect(c.state!.players.find((p) => p.playerUUID === victimUUID)?.isAlive).toBe(false);
        }
    });
});

describe('security: target validation', () => {
    it('rejects a werewolf voting for a corpse or a non-existent player', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(LYNCH_ROLES);
        await waitForTurnEverywhere(game, Role.WEREWOLF);

        // Night 0 kills a villager, then the GM walks the game to night 1.
        const corpse = game.clientsWithRole(Role.VILLAGER)[0]!;
        const wolves = game.clientsWithRole(Role.WEREWOLF);
        expect(wolves).toHaveLength(2);
        for (const wolf of wolves) {
            wolf.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: corpse.playerUUID });
        }
        await waitForTurnEverywhere(game, Role.SEER);
        game.clientsWithRole(Role.SEER)[0]!.socket.emit('seerConfirmed', { gameId: game.gameId });
        await game.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);
        expect(
            corpse.state!.players.find((p) => p.playerUUID === corpse.playerUUID)!.isAlive,
        ).toBe(false);

        await advanceManager(game, (s) => s.sheriffElectionDone, 'sheriff election resolved');
        await advanceManager(game, (s) => s.phase === Phase.DAY, 'day');
        await advanceManager(game, (s) => s.lynchDone, 'empty nominations resolved');
        await advanceManager(
            game,
            (s) => s.phase === Phase.NIGHT && s.activeNightRole === Role.WEREWOLF,
            'night one, werewolf turn',
        );
        await Promise.all(
            connected(game).map((c) =>
                c.waitFor(
                    (s) => s.phase === Phase.NIGHT && s.activeNightRole === Role.WEREWOLF,
                    'night one everywhere',
                ),
            ),
        );

        const wolf = wolves[0]!;
        expect(wolf.state!.werewolfVotes).toBeNull();

        const corpseError = await emitExpectError(
            wolf,
            'werewolfVote',
            { gameId: game.gameId, targetUUID: corpse.playerUUID },
            'werewolf votes for a corpse',
        );
        expect(corpseError).toMatch(/dead/i);

        const missingError = await emitExpectError(
            wolf,
            'werewolfVote',
            { gameId: game.gameId, targetUUID: 'does-not-exist' },
            'werewolf votes for an unknown player',
        );
        expect(missingError).toMatch(/not found/i);

        for (const c of wolves) {
            expect(c.state!.werewolfVotes).toBeNull();
            expect(c.state!.phase).toBe(Phase.NIGHT);
            expect(c.state!.activeNightRole).toBe(Role.WEREWOLF);
        }
        expect(wolf.errors).toHaveLength(2);
    });

    it('rejects a cupid binding a player to themselves', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(FULL_ROLES);
        await waitForTurnEverywhere(game, Role.CUPID);

        const cupid = game.clientsWithRole(Role.CUPID)[0]!;
        const villager = game.clientsWithRole(Role.VILLAGER)[0]!;

        const error = await emitExpectError(
            cupid,
            'bindLovers',
            {
                gameId: game.gameId,
                firstPlayerUUID: villager.playerUUID,
                secondPlayerUUID: villager.playerUUID,
            },
            'cupid binds one player to themselves',
        );
        expect(error).toMatch(/themselves/i);

        // The rejected bond must not have touched any player.
        expect(cupid.state!.activeNightRole).toBe(Role.CUPID);
        expect(cupid.state!.playerUUID).not.toBeNull();
        expect(cupid.state!.cupidSelectedLovers).toBe(false);
        expect(cupid.state!.cupidFirstLoverUUID).toBeNull();
        expect(cupid.state!.cupidSecondLoverUUID).toBeNull();
        expect(cupid.state!.lovePartnerUUID).toBeNull();
        expect(villager.state!.lovePartnerUUID).toBeNull();
        expect(villager.state!.lovePartnerConfirmed).toBe(false);
        expect(villager.state!.phase).toBe(Phase.NIGHT);
    });
});

describe('security: snapshot leaks', () => {
    it('keeps werewolf votes, roles and role-private fields out of the wrong snapshots', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(FULL_ROLES);
        await waitForTurnEverywhere(game, Role.CUPID);

        const cupid = game.clientsWithRole(Role.CUPID)[0]!;
        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const seer = game.clientsWithRole(Role.SEER)[0]!;
        const witch = game.clientsWithRole(Role.WITCH)[0]!;
        const villager = game.clientsWithRole(Role.VILLAGER)[0]!;

        // Bind the two wolves: that keeps the villager a clean, uninvolved observer.
        cupid.socket.emit('bindLovers', {
            gameId: game.gameId,
            firstPlayerUUID: wolves[0]!.playerUUID,
            secondPlayerUUID: wolves[1]!.playerUUID,
        });
        await cupid.waitFor((s) => s.cupidFirstLoverUUID !== null, 'cupid bound the lovers');
        for (const wolf of wolves) {
            wolf.socket.emit('confirmLoverBond', { gameId: game.gameId });
        }

        await waitForTurnEverywhere(game, Role.WEREWOLF);
        const villagerUUID = villager.playerUUID!;
        for (const wolf of wolves) {
            wolf.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: villagerUUID });
        }

        await waitForTurnEverywhere(game, Role.SEER);
        const witchUUID = witch.playerUUID!;
        seer.socket.emit('revealRole', { gameId: game.gameId, revealUUID: witchUUID });
        await seer.waitFor((s) => s.seerRevealUUID === witchUUID, 'seer reveal');

        // A plain villager sees no night secret at all.
        const villagerState = villager.state!;
        expect(villagerState.werewolfVotes).toBeNull();
        expect(villagerState.werewolfVictim).toBeNull();
        expect(villagerState.players.every((p) => p.role === null)).toBe(true);
        expect(villagerState.seerRevealUUID).toBeNull();
        expect(villagerState.seerRevealRole).toBeNull();
        expect(villagerState.witchUsedHealingPotion).toBe(false);
        expect(villagerState.witchUsedKillingPotion).toBe(false);
        expect(villagerState.redLadySleepoverUUID).toBeNull();
        expect(villagerState.cupidFirstLoverUUID).toBeNull();
        expect(villagerState.cupidSecondLoverUUID).toBeNull();
        expect(villagerState.lovePartnerUUID).toBeNull();

        // B47 scopes cupidSelectedLovers to the manager and the participants, so pin it on
        // a client that is neither: with two wolves as lovers several such clients exist.
        const bystander = connected(game).find(
            (c) => c !== game.manager && c !== wolves[0] && c !== wolves[1] && c !== cupid,
        )!;
        expect(bystander.state!.cupidSelectedLovers).toBe(false);

        // The witch may see the victim, but never the wolves' identities.
        const witchState = witch.state!;
        expect(witchState.werewolfVictim).toBe(villagerUUID);
        expect(witchState.werewolfVotes).toBeNull();
        expect(witchState.players.every((p) => p.role === null)).toBe(true);
        expect(witchState.seerRevealUUID).toBeNull();

        // The seer only ever sees their own reveal.
        const seerState = seer.state!;
        expect(seerState.seerRevealUUID).toBe(witchUUID);
        expect(seerState.seerRevealRole).toBe(Role.WITCH);
        expect(seerState.werewolfVotes).toBeNull();
        expect(seerState.werewolfVictim).toBeNull();
        expect(seerState.players.every((p) => p.role === null)).toBe(true);

        for (const c of connected(game)) {
            if (c !== seer) {
                expect(c.state!.seerRevealUUID).toBeNull();
                expect(c.state!.seerRevealRole).toBeNull();
            }
            if (wolves.includes(c)) {
                expect(c.state!.werewolfVotes).toEqual({
                    [wolves[0]!.playerUUID!]: villagerUUID,
                    [wolves[1]!.playerUUID!]: villagerUUID,
                });
                expect(c.state!.werewolfVictim).toBe(villagerUUID);
            } else if (c === witch) {
                expect(c.state!.werewolfVotes).toBeNull();
                expect(c.state!.werewolfVictim).toBe(villagerUUID);
            } else {
                expect(c.state!.werewolfVotes).toBeNull();
                expect(c.state!.werewolfVictim).toBeNull();
            }
        }

        game.expectNoErrors();
    });
});

describe('security: GM escape hatch', () => {
    it('is manager-only and advances exactly one night step', async () => {
        game = await TestGame.create({ playerCount: 6 });

        // In the lobby it is an error, not a silent phase skip.
        await emitExpectError(
            game.manager,
            'managerAdvance',
            { gameId: game.gameId },
            'managerAdvance in the lobby',
        );
        expect(connected(game).every((c) => c.state!.phase === Phase.LOBBY)).toBe(true);

        await game.setupAndStart(FULL_ROLES);
        await waitForTurnEverywhere(game, Role.CUPID);

        const nonManager = game.clients[1]!;
        await emitExpectError(
            nonManager,
            'managerAdvance',
            { gameId: game.gameId },
            'non-manager managerAdvance',
        );
        for (const c of connected(game)) {
            expect(c.state!.phase).toBe(Phase.NIGHT);
            expect(c.state!.activeNightRole).toBe(Role.CUPID);
        }

        await advanceManager(game, (s) => s.activeNightRole === Role.WEREWOLF, 'one step to the wolves');
        await advanceManager(game, (s) => s.activeNightRole === Role.SEER, 'one step to the seer');
        await Promise.all(
            connected(game).map((c) =>
                c.waitFor((s) => s.activeNightRole === Role.SEER, 'seer turn everywhere'),
            ),
        );

        for (const c of connected(game)) {
            expect(c.state!.phase).toBe(Phase.NIGHT);
            expect(c.state!.activeNightRole).toBe(Role.SEER);
        }
        expect(nonManager.errors).toHaveLength(1);
        expect(game.manager.errors).toHaveLength(1);
    });
});

describe('security: intentional dead-role reveal', () => {
    it('shows a dead player role to everyone, and only the dead one', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(LYNCH_ROLES);
        await waitForTurnEverywhere(game, Role.WEREWOLF);

        const victim = game.clientsWithRole(Role.VILLAGER)[0]!;
        const victimUUID = victim.playerUUID!;
        const roleBeforeDeath = victim.state!.role;
        expect(roleBeforeDeath).toBe(Role.VILLAGER);

        for (const wolf of game.clientsWithRole(Role.WEREWOLF)) {
            wolf.socket.emit('werewolfVote', { gameId: game.gameId, targetUUID: victimUUID });
        }
        await waitForTurnEverywhere(game, Role.SEER);
        game.clientsWithRole(Role.SEER)[0]!.socket.emit('seerConfirmed', { gameId: game.gameId });
        await game.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);

        const living = connected(game).find((c) => c !== victim && alive(c))!;
        for (const c of connected(game)) {
            const deadEntry = c.state!.players.find((p) => p.playerUUID === victimUUID)!;
            expect(deadEntry.isAlive).toBe(false);
            // B42: deliberate, the death popup renders this role.
            expect(deadEntry.role).toBe(roleBeforeDeath);

            const livingEntry = c.state!.players.find((p) => p.playerUUID === living.playerUUID)!;
            expect(livingEntry.isAlive).toBe(true);
            expect(livingEntry.role).toBeNull();
        }

        game.expectNoErrors();
    });
});
