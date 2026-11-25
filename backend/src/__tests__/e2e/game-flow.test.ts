import { describe, it, expect, afterEach } from 'vitest';
import { TestGame } from './harness.js';
import type { Client, Snapshot } from './harness.js';
import { Phase } from '@shared/phases.js';
import { Role, ROLES } from '@shared/roles.js';

// Full games over the real socket contract. Every assertion is made on a tailored
// snapshot, because that is all a player ever sees.
//
// Roles are dealt at random: who holds which role is always read from `state.role`,
// never assumed. The night is driven from `shared/roles.ts` (nightOrder, lower first),
// so a change to the order is picked up here instead of being hardcoded.

const SIX_FIRST_NIGHT: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.SEER]: 1,
    [Role.WITCH]: 1,
    [Role.CUPID]: 1,
    [Role.VILLAGER]: 1,
};

// No lovers: every death is exactly the death that was ordered.
const SIX_NO_LOVERS: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.SEER]: 1,
    [Role.WITCH]: 1,
    [Role.VILLAGER]: 2,
};

// Cupid so the witch can poison one half of a couple.
const SIX_WITCH_KILL: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.CUPID]: 1,
    [Role.WITCH]: 1,
    [Role.SEER]: 1,
    [Role.VILLAGER]: 1,
};

// Four players, not six, on purpose: the couple can be the last pair alive at the end of the
// first day, so the scenario never needs a second night. (A second night with a cupid in the
// game is where the round-increment bug in `startNight` shows up; test 3 owns that assertion.)
const FOUR_COUPLE: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.CUPID]: 1,
    [Role.VILLAGER]: 1,
};

const SIX_RED_LADY: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.RED_LADY]: 1,
    [Role.VILLAGER]: 3,
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

/** Runs `check` on every snapshot matching `filter`, for every client, labelled by client and index. */
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

/** Roles that wake up tonight, in `ROLES[...].nightOrder` order (lower first). */
function livingNightOrder(target: TestGame, round: number): Role[] {
    const livingRoles = new Set(target.aliveClients().map((c) => c.state?.role ?? null));
    return (Object.values(Role) as Role[])
        .filter((role) => {
            const def = ROLES[role];
            if (!def.wakesUp) return false;
            if (!livingRoles.has(role)) return false;
            if (def.onlyFirstNight && round > 0) return false;
            return true;
        })
        .sort((a, b) => ROLES[a].nightOrder - ROLES[b].nightOrder);
}

interface NightPlan {
    /** The two players cupid binds; both confirm the bond. */
    lovers?: [Client, Client];
    /** The player the werewolves agree on (also the heal target). */
    wolfTarget: Client;
    /** Whom the seer looks at. Defaults to the first living werewolf. */
    seerTarget?: Client;
    /** Witch usage. Omitted means the witch passes. */
    witch?: { heal?: boolean; kill?: Client };
    /** Where the red lady sleeps. */
    redLadyTarget?: Client;
}

interface NightObservations {
    seerRevealUUID: string | null;
    seerRevealRole: string | null;
    redLadySleepoverUUID: string | null;
}

/**
 * Plays one whole night: every living role takes its turn in the order published in
 * `shared/roles.ts`, and the turn only advances after the real action contract was used.
 * Returns what only those players were shown, for assertions that must happen mid-night
 * (night actions are cleared at dawn).
 */
async function playNight(target: TestGame, round: number, plan: NightPlan): Promise<NightObservations> {
    const observations: NightObservations = {
        seerRevealUUID: null,
        seerRevealRole: null,
        redLadySleepoverUUID: null,
    };

    const order = livingNightOrder(target, round);
    expect(order.length, 'the night needs at least one role that wakes up').toBeGreaterThan(0);
    expect(target.clients[0]!.state?.activeNightRole, 'the night starts with the earliest waking role').toBe(order[0]);

    for (const role of order) {
        const actors = target.aliveClients().filter((c) => c.state?.role === role);
        expect(actors.length, `an alive ${role} is needed for its turn`).toBeGreaterThan(0);
        const actor = actors[0]!;

        // Wait for the sub-turn on every client, not just the actor: a snapshot that is
        // wrong for one phone is a desync even if the actor could proceed.
        await Promise.all(target.clients.map((c) => c.waitForTurn(role)));

        switch (role) {
            case Role.CUPID: {
                const [first, second] = plan.lovers ?? [];
                if (!first || !second) throw new Error('night plan is missing a lover pair for cupid');
                actor.socket.emit('bindLovers', {
                    gameId: target.gameId,
                    firstPlayerUUID: first.playerUUID,
                    secondPlayerUUID: second.playerUUID,
                });
                await actor.waitFor((s) => s.cupidSelectedLovers, 'cupid bound the lovers');
                first.socket.emit('confirmLoverBond', { gameId: target.gameId });
                await actor.waitFor(
                    (s) => s.cupidFirstLoverConfirmed || s.cupidSecondLoverConfirmed,
                    'one lover confirmed the bond',
                );
                second.socket.emit('confirmLoverBond', { gameId: target.gameId });
                break;
            }
            case Role.WEREWOLF: {
                for (let i = 0; i < actors.length; i++) {
                    const wolf = actors[i]!;
                    wolf.socket.emit('werewolfVote', { gameId: target.gameId, targetUUID: plan.wolfTarget.playerUUID });
                    if (i < actors.length - 1) {
                        // Negative space: a wolf has voted, but the kill must not be decided yet.
                        const voted = await wolf.waitFor(
                            (s) => Object.keys(s.werewolfVotes ?? {}).length >= i + 1,
                            `werewolf vote ${i + 1} recorded`,
                        );
                        expect(voted.phase).toBe(Phase.NIGHT);
                        expect(voted.activeNightRole).toBe(Role.WEREWOLF);
                        expect(voted.werewolfVictim, 'no victim until every wolf voted').toBeNull();
                    }
                }
                break;
            }
            case Role.SEER: {
                const revealTarget = plan.seerTarget ?? target.aliveClients().find((c) => c.state?.role === Role.WEREWOLF);
                if (!revealTarget) throw new Error('night plan has no seer target');
                actor.socket.emit('revealRole', { gameId: target.gameId, revealUUID: revealTarget.playerUUID });
                const revealed = await actor.waitFor(
                    (s) => s.seerRevealUUID === revealTarget.playerUUID,
                    'seer looked at a card',
                );
                expect(revealed.seerRevealRole, 'the seer learns the true role').toBe(revealTarget.state?.role);
                observations.seerRevealUUID = revealed.seerRevealUUID;
                observations.seerRevealRole = revealed.seerRevealRole;
                // Negative space: the reveal is for the seer only.
                for (const other of target.clients.filter((c) => c !== actor)) {
                    expect(other.state?.seerRevealRole, `${other.playerUUID} must not see the seer's reveal`).toBeNull();
                }
                actor.socket.emit('seerConfirmed', { gameId: target.gameId });
                break;
            }
            case Role.WITCH: {
                const usage = plan.witch;
                if (usage && (usage.heal || usage.kill)) {
                    if (usage.heal) {
                        // The witch can only heal what she is shown.
                        expect(actor.state?.werewolfVictim, 'the witch is shown the werewolf victim').toBe(
                            plan.wolfTarget.playerUUID,
                        );
                    }
                    actor.socket.emit('usePotion', {
                        gameId: target.gameId,
                        heal: !!usage.heal,
                        killUUID: usage.kill?.playerUUID ?? null,
                    });
                    await actor.waitFor(
                        (s) =>
                            (usage.heal ? s.witchUsedHealingPotion : true) &&
                            (usage.kill ? s.witchUsedKillingPotion : true),
                        'witch potion was recorded',
                    );
                }
                actor.socket.emit('witchConfirms', { gameId: target.gameId });
                break;
            }
            case Role.RED_LADY: {
                const host = plan.redLadyTarget;
                if (!host) throw new Error('night plan is missing a red lady target');
                actor.socket.emit('sleepover', { gameId: target.gameId, sleepoverUUID: host.playerUUID });
                const seen = await actor.waitFor(
                    (s) => s.redLadySleepoverUUID === host.playerUUID,
                    'red lady chose a host',
                );
                observations.redLadySleepoverUUID = seen.redLadySleepoverUUID;
                break;
            }
            default:
                throw new Error(`no test driver for the waking role ${role}`);
        }
    }

    return observations;
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
async function resolveLynch(target: TestGame, victim: Client): Promise<void> {
    const alive = target.aliveClients();
    expect(alive, 'the lynch victim must be alive').toContain(victim);
    const nominator = alive.find((c) => c !== victim) ?? victim;
    await nominateAll(target, (client) => (client === nominator ? victim : false));
    await voteAll(target, () => victim, (s) => s.lynchDone, `lynch of ${victim.playerUUID} resolved`);
    for (const client of target.clients) {
        expect(client.state?.votedOutUUID, `${client.playerUUID} sees the lynched player`).toBe(victim.playerUUID);
    }
}

/** Every living player confirms, which starts the next night. */
async function readyForNight(target: TestGame): Promise<void> {
    for (const client of target.aliveClients()) {
        client.socket.emit('readyForNight', { gameId: target.gameId });
    }
    await target.waitForPhaseEverywhere(Phase.NIGHT);
}

/** GM path: nobody is nominated, so the election resolves without a sheriff and the GM opens the day. */
async function skipSheriffElection(target: TestGame): Promise<void> {
    await target.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);
    await nominateAll(target, () => false);
    const resolved = await target.manager.waitFor(
        (s) => s.phase === Phase.SHERIFF_ELECTION && s.sheriffElectionDone,
        'sheriff election resolved without a candidate',
    );
    expect(resolved.players.some((p) => p.isSheriff), 'nobody wears a badge').toBe(false);
    target.manager.socket.emit('acceptSheriffRole', { gameId: target.gameId });
    await target.waitForPhaseEverywhere(Phase.DAY);
}

/** Two candidates, `winner` gets every vote, the election is resolved but not accepted yet. */
async function runSheriffElection(target: TestGame, winner: Client, runnerUp: Client): Promise<void> {
    await nominateAll(target, (client) =>
        client === winner ? runnerUp : client === runnerUp ? winner : false,
    );
    await voteAll(target, () => winner, (s) => s.sheriffElectionDone, 'sheriff election resolved');
}

/**
 * Emits an event the server is expected to reject and resolves with its error message.
 * The harness records the error in `client.errors` as well, so this client cannot be passed to
 * `expectNoErrors()` afterwards; assert its exact error count instead.
 */
async function expectRejected(
    client: Client,
    event: string,
    payload: unknown,
    label: string,
): Promise<string> {
    const wait = new Promise<string>((resolve, reject) => {
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
    return wait;
}

describe('full game flow', () => {
    it('1. plays a complete first night and the heal leaves nobody dead', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_FIRST_NIGHT);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const cupid = only(game, Role.CUPID);
        const seer = only(game, Role.SEER);
        const witch = only(game, Role.WITCH);
        const villager = only(game, Role.VILLAGER);
        const wolves = game.clientsWithRole(Role.WEREWOLF);
        expect(wolves).toHaveLength(2);
        expect(cupid.state?.role).toBe(Role.CUPID);

        const night = await playNight(game, 0, {
            lovers: [seer, villager],
            wolfTarget: villager,
            seerTarget: wolves[0]!,
            witch: { heal: true },
        });
        // The seer really learned a werewolf, which is what the heal has to protect.
        expect(night.seerRevealRole).toBe(Role.WEREWOLF);

        await game.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);

        // `Game.round` is not part of the snapshot (B48), so "round 0" is asserted through its
        // only observable consequence: the first dawn of the game is the sheriff election.
        eachSnapshot(game.clients, () => true, (s, where) => {
            expect(s.players.filter((p) => !p.isAlive), where).toHaveLength(0);
        });

        for (const client of game.clients) {
            const state = client.state!;
            expect(state.phase, `${client.playerUUID} phase at dawn`).toBe(Phase.SHERIFF_ELECTION);
            expect(state.activeNightRole, `${client.playerUUID} has no lingering night turn`).toBeNull();
            expect(state.sheriffElectionDone).toBe(false);
            expect(state.lynchDone).toBe(false);
            expect(
                state.players.find((p) => p.playerUUID === villager.playerUUID)?.isAlive,
                `${client.playerUUID} sees the healed villager alive`,
            ).toBe(true);
        }

        expect(witch.state?.witchUsedHealingPotion).toBe(true);
        expect(witch.state?.witchUsedKillingPotion).toBe(false);

        // Negative space: the villager never saw a single werewolf vote this night.
        eachSnapshot([villager], () => true, (s, where) => {
            expect(s.werewolfVotes, where).toBeNull();
            expect(s.werewolfVictim, where).toBeNull();
        });

        game.expectNoErrors();
    });

    it('2a. resolves a sheriff election and the elected sheriff accepts the badge', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_NO_LOVERS);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const villager = game.clientsWithRole(Role.VILLAGER)[0]!;
        const wolf = game.clientsWithRole(Role.WEREWOLF)[0]!;
        await playNight(game, 0, { wolfTarget: villager, seerTarget: wolf, witch: {} });
        await game.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);
        expect(game.aliveClients()).toHaveLength(5);

        const nonManagers = game.aliveClients().filter((c) => !c.state?.isManager);
        expect(nonManagers.length).toBeGreaterThanOrEqual(2);
        const sheriff = nonManagers[0]!;
        const runnerUp = nonManagers[1]!;

        await runSheriffElection(game, sheriff, runnerUp);

        // The badge is visible before anyone accepts, and only to the elected player.
        for (const client of game.clients) {
            const state = client.state!;
            expect(state.phase).toBe(Phase.SHERIFF_ELECTION);
            expect(state.sheriffElectionDone).toBe(true);
            const sheriffs = state.players.filter((p) => p.isSheriff).map((p) => p.playerUUID);
            expect(sheriffs, `${client.playerUUID} sees exactly the elected sheriff`).toEqual([sheriff.playerUUID]);
        }
        // Negative space: a badge is public, roles are not.
        for (const player of sheriff.state!.players.filter((p) => p.isAlive)) {
            expect(player.role, `living player ${player.playerUUID} must stay hidden`).toBeNull();
        }

        sheriff.socket.emit('acceptSheriffRole', { gameId: game.gameId });
        await game.waitForPhaseEverywhere(Phase.DAY);

        // One more legitimate broadcast on the day: the badge has to survive every later sync.
        sheriff.socket.emit('nominate', { gameId: game.gameId, nominationUUID: runnerUp.playerUUID });
        await game.manager.waitFor(
            (s) => s.players.some((p) => p.nomination === runnerUp.playerUUID),
            'a day nomination was recorded',
        );

        eachSnapshot(game.clients, (s) => s.phase === Phase.DAY, (s, where) => {
            expect(s.sheriffElectionDone, where).toBe(true);
            expect(s.players.filter((p) => p.isSheriff).map((p) => p.playerUUID), where).toEqual([
                sheriff.playerUUID,
            ]);
        });

        game.expectNoErrors();
    });

    it('2b. lets the GM open the day when the elected sheriff never accepts', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_NO_LOVERS);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const villager = game.clientsWithRole(Role.VILLAGER)[0]!;
        const wolf = game.clientsWithRole(Role.WEREWOLF)[0]!;
        await playNight(game, 0, { wolfTarget: villager, seerTarget: wolf, witch: {} });
        await game.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);

        const nonManagers = game.aliveClients().filter((c) => !c.state?.isManager);
        const sheriff = nonManagers[0]!;
        const runnerUp = nonManagers[1]!;
        await runSheriffElection(game, sheriff, runnerUp);
        await game.manager.waitFor((s) => s.sheriffElectionDone, 'sheriff election resolved');

        // The elected sheriff stays silent forever; the GM is the documented way out.
        game.manager.socket.emit('acceptSheriffRole', { gameId: game.gameId });
        await game.waitForPhaseEverywhere(Phase.DAY);

        for (const client of game.clients) {
            const state = client.state!;
            expect(state.phase, `${client.playerUUID} phase`).toBe(Phase.DAY);
            // Continuing does not steal the badge: the elected sheriff keeps it.
            expect(state.players.filter((p) => p.isSheriff).map((p) => p.playerUUID)).toEqual([
                sheriff.playerUUID,
            ]);
        }

        game.expectNoErrors();
    });

    it('3. lynches by plurality, reveals the dead role and starts the next night', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_FIRST_NIGHT);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const seer = only(game, Role.SEER);
        const witch = only(game, Role.WITCH);
        const cupid = only(game, Role.CUPID);
        const villager = only(game, Role.VILLAGER);
        const wolf = game.clientsWithRole(Role.WEREWOLF)[0]!;

        // Night 1 without deaths, so the day starts with all six alive.
        await playNight(game, 0, {
            lovers: [seer, witch],
            wolfTarget: villager,
            seerTarget: wolf,
            witch: { heal: true },
        });
        await skipSheriffElection(game);
        expect(game.aliveClients()).toHaveLength(6);

        // Two candidates, plurality for the villager.
        const alive = game.aliveClients();
        const villageNominator = alive.find((c) => c !== villager && c !== cupid)!;
        const cupidNominator = alive.find((c) => c !== villager && c !== cupid && c !== villageNominator)!;
        await nominateAll(game, (client) =>
            client === villageNominator ? villager : client === cupidNominator ? cupid : false,
        );

        const ballots = new Map<Client, Client>();
        alive.forEach((client, index) => ballots.set(client, index < 4 ? villager : cupid));
        await voteAll(
            game,
            (client) => ballots.get(client)!,
            (s) => s.lynchDone,
            'plurality lynch resolved',
        );

        for (const client of game.clients) {
            expect(client.state?.votedOutUUID, `${client.playerUUID} votedOutUUID`).toBe(villager.playerUUID);
        }

        // B42: a dead player's role is public on purpose, living roles stay hidden.
        eachSnapshot(
            game.clients,
            (s) => s.phase === Phase.DAY && s.lynchDone,
            (s, where) => {
                const dead = s.players.find((p) => p.playerUUID === villager.playerUUID);
                expect(dead?.isAlive, where).toBe(false);
                expect(dead?.role, `${where} shows the dead villager's role`).toBe(Role.VILLAGER);
                for (const living of s.players.filter((p) => p.isAlive)) {
                    expect(living.role, `${where} leaks a living role`).toBeNull();
                }
                expect(s.voteProgress?.total, `${where} counts only the living`).toBe(5);
            },
        );

        // Negative space: a corpse cannot move the phase along, no matter what it sends.
        villager.socket.emit('nominate', { gameId: game.gameId, nominationUUID: seer.playerUUID });
        villager.socket.emit('readyForNight', { gameId: game.gameId });

        await readyForNight(game);

        eachSnapshot(
            [villager],
            (s) => s.phase === Phase.DAY && s.lynchDone,
            (s, where) => expect(s.readyForNight, `${where} accepted a dead player as ready`).toBe(false),
        );

        for (const client of game.clients) {
            const state = client.state!;
            expect(state.phase, `${client.playerUUID} phase after ready`).toBe(Phase.NIGHT);
            expect(state.lynchDone, 'lynch flag is reset for the new night').toBe(false);
        }

        // BUG (found by this test, reported): `startNight` resolves the first wake-up role
        // BEFORE incrementing `game.round` (vote.handler.ts:43-55). At the end of day 1 the
        // round is still 0, so cupid (onlyFirstNight) is scheduled again for night 2, where
        // `bindLovers` rejects the turn because the round is now 1. Night 2 then sits on a
        // turn nobody can legally take; only a lover's stale confirm or the GM escape hatch
        // moves it on. The assertion below is the load-bearing one: night 2 must start with
        // the first role that still wakes up once the first night is over.
        expect(
            game.clients[0]!.state?.activeNightRole,
            'night 2 must not wake the cupid: onlyFirstNight is over once the round incremented',
        ).toBe(livingNightOrder(game, 1)[0]);

        // Night 2 to prove the round really advanced: a second dawn is a day, not an election.
        await playNight(game, 1, { wolfTarget: cupid, seerTarget: wolf, witch: {} });
        await game.waitForPhaseEverywhere(Phase.DAY);

        expect(game.clients[0]!.state?.sheriffElectionDone, 'no second sheriff election').toBe(true);
        expect(seer.state?.lovePartnerUUID, 'the lovers survived an unrelated death').toBe(witch.playerUUID);
        expect(
            cupid.state?.players.find((p) => p.playerUUID === cupid.playerUUID)?.isAlive,
            'the cupid was the only death',
        ).toBe(false);

        game.expectNoErrors();
    });

    it('4. kills with the witch potion and takes the lover down with them', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_WITCH_KILL);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const cupid = only(game, Role.CUPID);
        const seer = only(game, Role.SEER);
        const witch = only(game, Role.WITCH);
        const villager = only(game, Role.VILLAGER);
        const wolf = game.clientsWithRole(Role.WEREWOLF)[0]!;

        await playNight(game, 0, {
            lovers: [seer, villager],
            // The wolves bite the cupid and the witch saves them...
            wolfTarget: cupid,
            seerTarget: wolf,
            // ...while poisoning the seer, whose lover dies with them.
            witch: { heal: true, kill: seer },
        });

        await game.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);

        for (const client of game.clients) {
            const state = client.state!;
            const dead = state.players
                .filter((p) => !p.isAlive)
                .map((p) => p.playerUUID)
                .sort();
            expect(dead, `${client.playerUUID} sees exactly the poisoned pair dead`).toEqual(
                [seer.playerUUID, villager.playerUUID].sort(),
            );
            // Negative space: the healed cupid is alive, and the dead roles are public.
            expect(state.players.find((p) => p.playerUUID === cupid.playerUUID)?.isAlive).toBe(true);
            expect(state.players.find((p) => p.playerUUID === seer.playerUUID)?.role).toBe(Role.SEER);
            expect(state.players.find((p) => p.playerUUID === witch.playerUUID)?.isAlive).toBe(true);
        }

        expect(witch.state?.witchUsedHealingPotion).toBe(true);
        expect(witch.state?.witchUsedKillingPotion).toBe(true);
        expect(game.aliveClients()).toHaveLength(4);

        game.expectNoErrors();
    });

    it('5. ends with a werewolf win when only wolves are left', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_NO_LOVERS);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const seer = only(game, Role.SEER);
        const witch = only(game, Role.WITCH);
        const villagers = game.clientsWithRole(Role.VILLAGER);
        expect(villagers).toHaveLength(2);

        await playNight(game, 0, { wolfTarget: villagers[0]!, seerTarget: wolves[0]!, witch: {} });
        await skipSheriffElection(game);
        await resolveLynch(game, villagers[1]!);

        // Two wolves against two villagers: the game must keep going.
        expect(game.aliveClients()).toHaveLength(4);
        expect(game.clients[0]!.state?.phase).toBe(Phase.DAY);

        await readyForNight(game);
        await playNight(game, 1, { wolfTarget: seer, seerTarget: wolves[0]!, witch: {} });
        await game.waitForPhaseEverywhere(Phase.DAY);
        expect(game.aliveClients()).toHaveLength(3);

        await resolveLynch(game, witch);

        await game.waitForPhaseEverywhere(Phase.GAME_OVER);

        for (const client of game.clients) {
            const state = client.state!;
            expect(state.phase, `${client.playerUUID} phase`).toBe(Phase.GAME_OVER);
            expect(state.winningTeam, `${client.playerUUID} winning team`).toBe('werewolves');
            expect(
                state.players.filter((p) => p.isAlive).every((p) => p.role === Role.WEREWOLF),
                'only wolves are alive',
            ).toBe(true);
        }

        // Negative space: the game never ended any other way, and never before the wolves were alone.
        eachSnapshot(game.clients, (s) => s.phase === Phase.GAME_OVER, (s, where) => {
            expect(s.winningTeam, where).toBe('werewolves');
        });
        eachSnapshot(game.clients, (s) => s.winningTeam !== null && s.winningTeam !== '', (s, where) => {
            expect(s.phase, where).toBe(Phase.GAME_OVER);
        });

        game.expectNoErrors();
    });

    it('6. ends with a village win when the last werewolf is lynched', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_NO_LOVERS);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const villagers = game.clientsWithRole(Role.VILLAGER);
        expect(wolves).toHaveLength(2);

        await playNight(game, 0, { wolfTarget: villagers[0]!, seerTarget: wolves[0]!, witch: {} });
        await skipSheriffElection(game);
        await resolveLynch(game, wolves[0]!);

        // One wolf left: not over yet.
        expect(game.aliveClients()).toHaveLength(4);
        expect(game.clients[0]!.state?.phase).toBe(Phase.DAY);

        await readyForNight(game);
        await playNight(game, 1, { wolfTarget: villagers[1]!, seerTarget: wolves[1]!, witch: {} });
        await game.waitForPhaseEverywhere(Phase.DAY);
        expect(game.aliveClients()).toHaveLength(3);

        await resolveLynch(game, wolves[1]!);
        await game.waitForPhaseEverywhere(Phase.GAME_OVER);

        for (const client of game.clients) {
            const state = client.state!;
            expect(state.phase, `${client.playerUUID} phase`).toBe(Phase.GAME_OVER);
            expect(state.winningTeam, `${client.playerUUID} winning team`).toBe('village');
            // GAME_OVER reveals every role for the summary screen.
            for (const player of state.players) {
                expect(player.role, `${client.playerUUID} sees the role of ${player.playerUUID}`).not.toBeNull();
            }
        }

        // Negative space: a village win never happens while a wolf is alive.
        eachSnapshot(game.clients, (s) => s.winningTeam === 'village', (s, where) => {
            expect(
                s.players.filter((p) => p.isAlive && p.role === Role.WEREWOLF),
                `${where} declares a village win with a living wolf`,
            ).toHaveLength(0);
        });

        game.expectNoErrors();
    });

    it('7. ends with a couple win when the last two survivors are the lovers', async () => {
        game = await TestGame.create({ playerCount: 4 });
        await game.setupAndStart(FOUR_COUPLE);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const cupid = only(game, Role.CUPID);
        const villageLover = only(game, Role.VILLAGER);
        expect(wolves).toHaveLength(2);
        const wolfLover = wolves[0]!;

        // Night 1: bind a wolf to the only villager, then kill cupid. Three left.
        await playNight(game, 0, { lovers: [wolfLover, villageLover], wolfTarget: cupid });
        await skipSheriffElection(game);
        expect(game.aliveClients()).toHaveLength(3);

        // The other wolf is lynched: the survivors are exactly the two lovers.
        await resolveLynch(game, wolves[1]!);
        await game.waitForPhaseEverywhere(Phase.GAME_OVER);

        for (const client of game.clients) {
            const state = client.state!;
            expect(state.phase, `${client.playerUUID} phase`).toBe(Phase.GAME_OVER);
            // A wolf is alive, so this must not be a werewolf win, and the village has not
            // cleared the wolves either: the couple check has to win the race.
            expect(state.winningTeam, `${client.playerUUID} winning team`).toBe('couple');
            expect(
                state.players
                    .filter((p) => p.isAlive)
                    .map((p) => p.playerUUID)
                    .sort(),
                'the survivors are exactly the lovers',
            ).toEqual([wolfLover.playerUUID, villageLover.playerUUID].sort());
        }

        // The couple really is cross-team, and both sides know their partner.
        expect(wolfLover.state?.lovePartnerUUID).toBe(villageLover.playerUUID);
        expect(villageLover.state?.lovePartnerUUID).toBe(wolfLover.playerUUID);
        expect(
            wolfLover.state!.players
                .filter((p) => p.isAlive)
                .map((p) => p.role)
                .sort(),
            'one wolf and one villager, not a village pair',
        ).toEqual([Role.VILLAGER, Role.WEREWOLF].sort());

        // Negative space: the couple win is not announced before the pair is alone.
        eachSnapshot(game.clients, (s) => s.winningTeam === 'couple', (s, where) => {
            expect(s.players.filter((p) => p.isAlive), `${where} announced a couple win too early`).toHaveLength(2);
        });

        game.expectNoErrors();
    });

    it('8. kills the red lady when the host she visits is murdered', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_RED_LADY);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const redLady = only(game, Role.RED_LADY);
        const villagers = game.clientsWithRole(Role.VILLAGER);
        expect(villagers).toHaveLength(3);

        const host = villagers[0]!;
        const night = await playNight(game, 0, { redLadyTarget: host, wolfTarget: host });
        expect(night.redLadySleepoverUUID).toBe(host.playerUUID);

        await game.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);

        for (const client of game.clients) {
            const state = client.state!;
            expect(
                state.players
                    .filter((p) => !p.isAlive)
                    .map((p) => p.playerUUID)
                    .sort(),
                `${client.playerUUID} sees the host and the visiting red lady dead`,
            ).toEqual([host.playerUUID, redLady.playerUUID].sort());
            expect(state.players.find((p) => p.playerUUID === host.playerUUID)?.role).toBe(Role.VILLAGER);
            expect(state.players.find((p) => p.playerUUID === redLady.playerUUID)?.role).toBe(Role.RED_LADY);
        }

        // Negative space: only the red lady ever saw where she slept.
        for (const client of game.clients.filter((c) => c !== redLady)) {
            expect(client.state?.redLadySleepoverUUID, `${client.playerUUID} must not see the visit`).toBeNull();
        }
        expect(game.aliveClients()).toHaveLength(4);

        game.expectNoErrors();
    });

    it('9. takes the badge off a sheriff killed at night, so a 2-2 tie lynch kills nobody', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_NO_LOVERS);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const villagers = game.clientsWithRole(Role.VILLAGER);
        expect(villagers).toHaveLength(2);

        // Night 0 with the heal: all six reach the election, which keeps four voters for the tie.
        await playNight(game, 0, { wolfTarget: villagers[0]!, seerTarget: wolves[0]!, witch: { heal: true } });
        await game.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);
        expect(game.aliveClients()).toHaveLength(6);

        // Elect a sheriff the pack can actually kill: not the manager, not a werewolf.
        const candidates = game.aliveClients().filter(
            (c) => !c.state?.isManager && c.state?.role !== Role.WEREWOLF,
        );
        expect(candidates.length).toBeGreaterThanOrEqual(2);
        const sheriff = candidates[0]!;
        await runSheriffElection(game, sheriff, candidates[1]!);
        sheriff.socket.emit('acceptSheriffRole', { gameId: game.gameId });
        await game.waitForPhaseEverywhere(Phase.DAY);

        for (const client of game.clients) {
            expect(
                client.state?.players.filter((p) => p.isSheriff).map((p) => p.playerUUID),
                `${client.playerUUID} before the kill`,
            ).toEqual([sheriff.playerUUID]);
        }

        // Day 1: lynch a villager that is not the sheriff, so five walk into night 1.
        const lynchVictim = villagers.find((c) => c !== sheriff)!;
        await resolveLynch(game, lynchVictim);
        await readyForNight(game);

        // Night 1: the pack kills the sheriff. Four alive for the tie.
        await playNight(game, 1, { wolfTarget: sheriff, seerTarget: wolves[0]!, witch: {} });
        await game.waitForPhaseEverywhere(Phase.DAY);
        expect(game.aliveClients()).toHaveLength(4);

        const deadAtDawn = game.clients[0]!.state!.players
            .filter((p) => !p.isAlive)
            .map((p) => p.playerUUID)
            .sort();
        expect(deadAtDawn, 'exactly the day-1 lynch and the night kill are dead').toEqual(
            [lynchVictim.playerUUID, sheriff.playerUUID].sort(),
        );

        // The badge rule over the whole history: exactly one badge while the elected sheriff
        // lives, zero badges from the moment the corpse appears (it is cleared, not passed on).
        for (const client of game.clients) {
            const state = client.state!;
            const elected = state.players.find((p) => p.playerUUID === sheriff.playerUUID)!;
            expect(elected.isAlive, `${client.playerUUID} saw the sheriff survive the night`).toBe(false);
        }
        eachSnapshot(game.clients, () => true, (s, where) => {
            const elected = s.players.find((p) => p.playerUUID === sheriff.playerUUID)!;
            const badges = s.players.filter((p) => p.isSheriff).map((p) => p.playerUUID);
            if (!s.sheriffElectionDone) {
                expect(badges, `${where}: a badge before the election was decided`).toEqual([]);
            } else if (elected.isAlive) {
                expect(badges, `${where}: the badge left the elected sheriff`).toEqual([sheriff.playerUUID]);
            } else {
                expect(badges, `${where}: the badge stayed on a corpse`).toEqual([]);
            }
        });

        // Day 2: two candidates, 2-2. A dead sheriff has no tie-break, so nobody is lynched.
        const alive = game.aliveClients();
        expect(alive).toHaveLength(4);
        const candidateA = alive[0]!;
        const candidateB = alive[1]!;
        await nominateAll(game, (client) =>
            client === candidateA ? candidateB : client === candidateB ? candidateA : false,
        );
        const ballots = new Map<Client, Client>();
        alive.forEach((client, index) => ballots.set(client, index < 2 ? candidateA : candidateB));
        await voteAll(game, (client) => ballots.get(client)!, (s) => s.lynchDone, 'tied lynch resolved');

        for (const client of game.clients) {
            const state = client.state!;
            expect(state.phase, `${client.playerUUID} phase after the tie`).toBe(Phase.DAY);
            expect(state.lynchDone).toBe(true);
            expect(state.votedOutUUID, `${client.playerUUID}: a tie must lynch nobody`).toBeNull();
            expect(
                state.players.filter((p) => !p.isAlive).map((p) => p.playerUUID).sort(),
                `${client.playerUUID}: the tie killed someone`,
            ).toEqual(deadAtDawn);
        }

        game.expectNoErrors();
    });

    it('10. lets a dead game manager end the sheriff election when every living player is powerless', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_NO_LOVERS);
        await game.waitForPhaseEverywhere(Phase.NIGHT);

        const manager = game.manager;
        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const managerIsWolf = manager.state?.role === Role.WEREWOLF;

        // The pack can never victimise its own: a wolf cannot vote for himself and the victim
        // needs a unanimous pack vote. So a manager dealt a werewolf has to fall to the witch's
        // poison instead; every other role is killed by the pack as usual. Either way the
        // manager is a corpse before the election resolves, which is the state under test.
        const wolfTarget = managerIsWolf
            ? game.clients.find((c) => c !== manager && c.state?.role !== Role.WEREWOLF)!
            : manager;

        await playNight(game, 0, {
            wolfTarget,
            seerTarget: wolves[0]!,
            witch: managerIsWolf ? { kill: manager } : {},
        });
        await game.waitForPhaseEverywhere(Phase.SHERIFF_ELECTION);

        for (const client of game.clients) {
            const state = client.state!;
            expect(state.phase, `${client.playerUUID} phase`).toBe(Phase.SHERIFF_ELECTION);
            expect(
                state.players.find((p) => p.playerUUID === manager.playerUUID)?.isAlive,
                `${client.playerUUID} sees the manager dead`,
            ).toBe(false);
            expect(state.sheriffElectionDone, 'the election is still open with the GM dead').toBe(false);
        }
        // The dead manager still is the manager, on its own snapshot.
        expect(manager.state?.isManager, 'death does not strip the manager badge').toBe(true);
        expect(manager.state?.phase).toBe(Phase.SHERIFF_ELECTION);

        // All abstain: the election resolves with no sheriff at all (the branch only the GM can leave).
        await nominateAll(game, () => false);
        const resolved = await manager.waitFor(
            (s) => s.phase === Phase.SHERIFF_ELECTION && s.sheriffElectionDone,
            'election resolved without a sheriff',
        );
        expect(resolved.players.some((p) => p.isSheriff), 'nobody was elected').toBe(false);

        // Negative space: a living player has no authority here, and the rejection changes nothing.
        const living = game.aliveClients();
        expect(living).toHaveLength(managerIsWolf ? 4 : 5);
        const intruder = living[0]!;
        const rejection = await expectRejected(
            intruder,
            'acceptSheriffRole',
            { gameId: game.gameId },
            'living non-manager tries to accept',
        );
        expect(rejection).toMatch(/only gm/i);
        expect(intruder.state?.phase, 'the rejected accept advanced the phase').toBe(
            Phase.SHERIFF_ELECTION,
        );
        expect(intruder.errors).toHaveLength(1);

        // ...but the corpse in the manager seat still can.
        const day = manager.waitFor((s) => s.phase === Phase.DAY, 'day after the dead manager accepted');
        manager.socket.emit('acceptSheriffRole', { gameId: game.gameId });
        await day;
        await game.waitForPhaseEverywhere(Phase.DAY);

        for (const client of game.clients) {
            const state = client.state!;
            expect(state.phase, `${client.playerUUID} phase after the dead GM continued`).toBe(Phase.DAY);
            expect(state.sheriffElectionDone).toBe(true);
            expect(state.players.some((p) => p.isSheriff), 'a skipped election elects nobody').toBe(false);
            expect(
                state.players.find((p) => p.playerUUID === manager.playerUUID)?.isAlive,
                'the manager is still dead',
            ).toBe(false);
        }

        // expectNoErrors() is not usable here: the single error is the deliberate rejection.
        for (const client of game.clients.filter((c) => c !== intruder)) {
            expect(client.errors, `${client.playerUUID} had unexpected server errors`).toHaveLength(0);
        }
    });
});
