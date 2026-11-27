import type { Role } from './roles.js';
import type { Phase } from './phases.js';

/**
 * Who won a finished game. `null` means the game is not over, or nobody won
 * because nobody was left alive.
 */
export type WinningTeam = 'village' | 'werewolves' | 'couple';

/**
 * The public view of one seat in a tailored snapshot.
 *
 * `role` is `null` while the player is alive and the game is running; it becomes
 * public when the player dies or when the phase is GAME_OVER.
 */
export interface SnapshotPlayer {
    playerUUID: string;
    displayName: string;
    isSheriff: boolean;
    isAlive: boolean;
    nomination: string | false | null;
    hasVoted: boolean;
    readyForNight: boolean;
    role: Role | null;
}

/**
 * The wire contract for one `syncState` payload.
 *
 * This is not the backend `Game`: it contains only what one player is allowed to
 * see. The field types live here; the audience rules (who may see which field)
 * live in `getLocalPlayerState`.
 */
export interface Snapshot {
    gameId: string;
    playerUUID: string;
    phase: Phase;
    activeNightRole: Role | null;
    players: SnapshotPlayer[];
    lynchDone: boolean;
    sheriffElectionDone: boolean;
    winningTeam: WinningTeam | null;

    displayName: string;
    isManager: boolean;
    role: Role | null;
    lovePartnerUUID: string | null;
    lovePartnerConfirmed: boolean;
    readyForNight: boolean;
    myVoteTargetUUID: string | false | null;
    myNominationUUID: string | false | null;

    nominationsFinished: boolean;
    voteResults: Record<string, string | false | null> | null;
    voteProgress: { voted: number; total: number };
    votedOutUUID: string | null;

    werewolfVotes: Record<string, string> | null;
    werewolfVictim: string | null;

    witchUsedHealingPotion: boolean;
    witchUsedKillingPotion: boolean;

    redLadySleepoverUUID: string | null;

    seerRevealUUID: string | null;
    seerRevealRole: Role | null;

    cupidSelectedLovers: boolean;
    cupidFirstLoverUUID: string | null;
    cupidSecondLoverUUID: string | null;
    cupidFirstLoverConfirmed: boolean;
    cupidSecondLoverConfirmed: boolean;
}
