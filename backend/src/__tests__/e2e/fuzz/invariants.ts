// Invariants checked after every sync of every fuzz game.
//
// Everything here is asserted against the *tailored snapshot*, because that is all a player
// ever sees. Nothing is weakened: if a check fails, the run is red and the driver prints the
// seed plus a dump.

import { Phase } from '@shared/phases.js';
import { Role } from '@shared/roles.js';
import type { Client, Snapshot, SnapshotPlayer } from '../harness.js';

export class InvariantViolation extends Error {
    constructor(
        readonly invariant: string,
        readonly detail: string,
    ) {
        super(`[invariant:${invariant}] ${detail}`);
        this.name = 'InvariantViolation';
    }
}

const fail = (invariant: string, detail: string): never => {
    throw new InvariantViolation(invariant, detail);
};

// The only legal phase changes. Staying in the same phase is always allowed and not listed.
const ALLOWED_TRANSITIONS = new Set<string>([
    `${Phase.LOBBY}->${Phase.ROLE_SELECTION}`,
    `${Phase.ROLE_SELECTION}->${Phase.DISTRIBUTION}`,
    `${Phase.DISTRIBUTION}->${Phase.NIGHT}`,
    `${Phase.NIGHT}->${Phase.SHERIFF_ELECTION}`,
    `${Phase.NIGHT}->${Phase.DAY}`,
    `${Phase.NIGHT}->${Phase.GAME_OVER}`,
    `${Phase.SHERIFF_ELECTION}->${Phase.DAY}`,
    `${Phase.DAY}->${Phase.NIGHT}`,
    `${Phase.DAY}->${Phase.GAME_OVER}`,
]);

interface Cursor {
    nextIndex: number;
    prev: Snapshot | null;
    dead: Set<string>;
}

const publicProjection = (s: Snapshot): string =>
    JSON.stringify({
        gameId: s.gameId,
        phase: s.phase,
        activeNightRole: s.activeNightRole,
        lynchDone: s.lynchDone,
        sheriffElectionDone: s.sheriffElectionDone,
        winningTeam: s.winningTeam,
        votedOutUUID: s.votedOutUUID,
        nominationsFinished: s.nominationsFinished,
        players: [...s.players]
            .sort((a, b) => a.playerUUID.localeCompare(b.playerUUID))
            .map((p) => ({
                playerUUID: p.playerUUID,
                displayName: p.displayName,
                isAlive: p.isAlive,
                isSheriff: p.isSheriff,
            })),
    });

export class InvariantChecker {
    private readonly cursors = new Map<Client, Cursor>();

    constructor(private readonly clients: Client[]) {}

    /** Processes every snapshot this checker has not seen yet, then cross-checks all clients. */
    check(): void {
        for (const client of this.clients) {
            let cursor = this.cursors.get(client);
            if (!cursor) {
                cursor = { nextIndex: 0, prev: null, dead: new Set() };
                this.cursors.set(client, cursor);
            }
            while (cursor.nextIndex < client.history.length) {
                const snapshot = client.history[cursor.nextIndex] as Snapshot;
                const where = `client ${client.playerUUID ?? '?'} snapshot #${cursor.nextIndex} (${snapshot.phase})`;
                this.checkSnapshot(snapshot, where);
                if (cursor.prev) {
                    this.checkTransition(cursor.prev, snapshot, where);
                }
                this.checkDeaths(cursor, snapshot, where);
                cursor.prev = snapshot;
                cursor.nextIndex++;
            }
        }
        this.checkConsistency();
    }

    // --- per snapshot ------------------------------------------------------

    private checkSnapshot(s: Snapshot, where: string): void {
        const me = s.players.find((p) => p.playerUUID === s.playerUUID);
        if (!me) fail('snapshot.self', `${where}: viewer ${s.playerUUID} is missing from players[]`);

        // activeNightRole exists exactly while the phase is NIGHT.
        if (s.phase === Phase.NIGHT && s.activeNightRole === null) {
            fail('phase.activeNightRole', `${where}: phase is NIGHT but activeNightRole is null`);
        }
        if (s.phase !== Phase.NIGHT && s.activeNightRole !== null) {
            fail('phase.activeNightRole', `${where}: activeNightRole is ${s.activeNightRole} outside NIGHT (${s.phase})`);
        }

        // No leak: living roles stay hidden until GAME_OVER; dead roles are public by design.
        for (const player of s.players) {
            if (player.role !== null && player.isAlive && s.phase !== Phase.GAME_OVER) {
                fail('leak.role', `${where}: living player ${player.playerUUID} exposes role ${player.role}`);
            }
        }

        // Werewolf state goes to living werewolves only (and the victim also to the witch).
        if (s.werewolfVotes !== null) {
            if (s.phase !== Phase.NIGHT || !me.isAlive || s.role !== Role.WEREWOLF) {
                fail('leak.werewolfVotes', `${where}: werewolfVotes sent to ${s.role} alive=${me.isAlive} phase=${s.phase}`);
            }
            for (const [wolfUUID, targetUUID] of Object.entries(s.werewolfVotes)) {
                const wolf = s.players.find((p) => p.playerUUID === wolfUUID);
                if (!wolf || !wolf.isAlive) {
                    fail('aggregate.werewolfVotes', `${where}: vote key ${wolfUUID} is not a living player`);
                }
                if (!s.players.some((p) => p.playerUUID === targetUUID)) {
                    fail('aggregate.werewolfVotes', `${where}: vote target ${targetUUID} does not exist`);
                }
            }
        }
        if (s.werewolfVictim !== null) {
            const allowed = s.role === Role.WEREWOLF || s.role === Role.WITCH;
            if (s.phase !== Phase.NIGHT || !me.isAlive || !allowed) {
                fail('leak.werewolfVictim', `${where}: werewolfVictim sent to ${s.role} alive=${me.isAlive} phase=${s.phase}`);
            }
            if (!s.players.some((p) => p.playerUUID === s.werewolfVictim)) {
                fail('aggregate.werewolfVictim', `${where}: victim ${s.werewolfVictim} does not exist`);
            }
        }

        // Role-private night state.
        if (s.seerRevealUUID !== null || s.seerRevealRole !== null) {
            if (s.role !== Role.SEER) fail('leak.seer', `${where}: seer reveal sent to ${s.role}`);
            if (s.seerRevealUUID === null || s.seerRevealRole === null) {
                fail('aggregate.seer', `${where}: half a seer reveal (uuid=${s.seerRevealUUID}, role=${s.seerRevealRole})`);
            }
        }
        if (s.redLadySleepoverUUID !== null && s.role !== Role.RED_LADY) {
            fail('leak.redLady', `${where}: red lady visit sent to ${s.role}`);
        }
        if ((s.witchUsedHealingPotion || s.witchUsedKillingPotion) && s.role !== Role.WITCH) {
            fail('leak.witch', `${where}: witch potion flags sent to ${s.role}`);
        }

        // Cupid state goes to the GM and the participants (cupid + the two lovers).
        const cupidParticipant = s.isManager || s.role === Role.CUPID || s.lovePartnerUUID !== null;
        if (s.cupidSelectedLovers && !cupidParticipant) {
            fail('leak.cupid', `${where}: cupidSelectedLovers sent to a non-participant`);
        }
        if ((s.cupidFirstLoverUUID !== null || s.cupidSecondLoverUUID !== null) && !cupidParticipant) {
            fail('leak.cupid', `${where}: cupid lover UUIDs sent to a non-participant`);
        }

        // Badge.
        const badges = s.players.filter((p) => p.isSheriff);
        if (badges.length > 1) {
            fail('badge.count', `${where}: ${badges.length} sheriffs (${badges.map((p) => p.playerUUID).join(', ')})`);
        }
        if (badges.length === 1 && !badges[0]?.isAlive) {
            fail('badge.dead', `${where}: dead player ${badges[0]?.playerUUID} is still the sheriff`);
        }
        if (!s.sheriffElectionDone && badges.length > 0) {
            fail('badge.early', `${where}: a badge exists before the election resolved`);
        }

        // Aggregates.
        const living = s.players.filter((p) => p.isAlive);
        if (s.voteProgress !== null) {
            if (s.voteProgress.total !== living.length) {
                fail('aggregate.voteProgress', `${where}: total ${s.voteProgress.total} but ${living.length} living players`);
            }
            if (s.voteProgress.voted > s.voteProgress.total) {
                fail('aggregate.voteProgress', `${where}: voted ${s.voteProgress.voted} > total ${s.voteProgress.total}`);
            }
        }
        if (s.votedOutUUID !== null && !s.players.some((p) => p.playerUUID === s.votedOutUUID)) {
            fail('aggregate.votedOutUUID', `${where}: votedOutUUID ${s.votedOutUUID} does not exist`);
        }

        // Terminal reveal: GAME_OVER shows every role for the summary screen.
        if (s.phase === Phase.GAME_OVER) {
            for (const player of s.players) {
                if (player.role === null) {
                    fail('terminal.reveal', `${where}: role of ${player.playerUUID} is hidden at GAME_OVER`);
                }
            }
        }
    }

    private checkTransition(prev: Snapshot, curr: Snapshot, where: string): void {
        if (prev.phase === Phase.GAME_OVER && curr.phase !== Phase.GAME_OVER) {
            fail('phase.terminal', `${where}: left GAME_OVER for ${curr.phase}`);
        }
        if (prev.phase !== curr.phase && !ALLOWED_TRANSITIONS.has(`${prev.phase}->${curr.phase}`)) {
            fail('phase.transition', `${where}: illegal transition ${prev.phase} -> ${curr.phase}`);
        }
    }

    private checkDeaths(cursor: Cursor, snapshot: Snapshot, where: string): void {
        const newlyDead: SnapshotPlayer[] = [];
        for (const player of snapshot.players) {
            if (!player.isAlive) {
                if (!cursor.dead.has(player.playerUUID)) {
                    const before = cursor.prev?.players.find((p) => p.playerUUID === player.playerUUID);
                    if (before?.isAlive) newlyDead.push(player);
                    cursor.dead.add(player.playerUUID);
                }
            } else if (cursor.dead.has(player.playerUUID)) {
                fail('death.monotonic', `${where}: ${player.playerUUID} was dead and is alive again`);
            }
        }

        if (cursor.prev && newlyDead.length > 0) {
            const names = newlyDead.map((p) => p.playerUUID).join(', ');
            if (snapshot.phase === Phase.NIGHT) {
                fail('death.timing', `${where}: ${names} died mid-night (active ${snapshot.activeNightRole})`);
            }
            if (snapshot.phase !== Phase.DAY && snapshot.phase !== Phase.SHERIFF_ELECTION && snapshot.phase !== Phase.GAME_OVER) {
                fail('death.timing', `${where}: ${names} died during ${snapshot.phase}`);
            }
        }
    }

    // --- cross-client ------------------------------------------------------

    private checkConsistency(): void {
        const states = this.clients
            .filter((c) => c.socket.connected && c.state !== null)
            .map((c) => c.state as Snapshot);
        if (states.length < 2) return;

        const base = publicProjection(states[0] as Snapshot);
        for (let i = 1; i < states.length; i++) {
            const other = publicProjection(states[i] as Snapshot);
            if (base !== other) {
                fail(
                    'consistency.public',
                    `public projection differs between clients\n  A: ${base.slice(0, 700)}\n  B: ${other.slice(0, 700)}`,
                );
            }
        }

        if ((states[0] as Snapshot).phase === Phase.GAME_OVER) {
            this.checkTerminal(states);
        }
    }

    /**
     * At GAME_OVER the winner has to match the living set. Couples are reconstructed from every
     * client's own `lovePartnerUUID`, because a snapshot never exposes another player's partner.
     */
    private checkTerminal(states: Snapshot[]): void {
        const first = states[0] as Snapshot;
        const living = first.players.filter((p) => p.isAlive);

        const partners = new Map<string, string>();
        for (const state of states) {
            if (state.lovePartnerUUID !== null) partners.set(state.playerUUID, state.lovePartnerUUID);
        }
        const mutualLovers = (a: string, b: string): boolean =>
            partners.get(a) === b && partners.get(b) === a;

        let expected: string | null | undefined;
        if (living.length === 0) {
            expected = null;
        } else if (
            living.length === 2 &&
            mutualLovers((living[0] as SnapshotPlayer).playerUUID, (living[1] as SnapshotPlayer).playerUUID)
        ) {
            expected = 'couple';
        } else if (living.every((p) => p.role === Role.WEREWOLF)) {
            expected = 'werewolves';
        } else if (!living.some((p) => p.role === Role.WEREWOLF)) {
            expected = 'village';
        } else {
            expected = undefined;
        }

        if (expected === undefined) {
            fail(
                'terminal.condition',
                `GAME_OVER with a living set no win condition covers: ${living
                    .map((p) => `${p.playerUUID}:${p.role}`)
                    .join(', ')}`,
            );
        }
        for (const state of states) {
            if (state.winningTeam !== expected) {
                fail(
                    'terminal.winner',
                    `client ${state.playerUUID}: winningTeam=${JSON.stringify(state.winningTeam)} expected ${JSON.stringify(expected)} ` +
                        `(living: ${living.map((p) => `${p.playerUUID}:${p.role}`).join(', ')})`,
                );
            }
        }
    }
}
