import { Role } from '@shared/roles.js'
import { Phase } from '@shared/phases.js';

export interface Player {
    // general
    playerUUID: string | null,
    socketId: string | null,
    displayName: string,
    role: Role | null,
    isAlive: boolean,
    nightAction: NightAction | null,
    // couple
    lovePartner: string | null,
    lovePartnerConfirmed: boolean,
    // witch
    usedHealingPotion: boolean,
    usedKillingPotion: boolean,
    // day
    voteTargetUUID: string | null, // who they vote for
    readyForNight: boolean
}

export interface Game {
    gameId: string,
    managerUUID: string | null, // PlayerUUID of Game Manager
    players: Player[],
    round: number,
    phase: Phase,
    activeNightRole: Role | null,
    winningTeam: string | null,

    sheriffUUID: string | null,
    lynchDone: boolean,
    sheriffElectionDone: boolean,
    lastVotedOutUUID: string | null,
}

export interface NightAction {
    // werewolf
    targetUUID?: string | null,
    // seer
    revealUUID?: string,
    revealedRole?: Role,
    // witch
    heal?: boolean,
    killUUID?: string | null,
    // cupid
    firstPlayerUUID?: string,
    secondPlayerUUID?: string,
    // red lady
    sleepoverUUID?: string
}

// # aggregated state (for frontend UI)

// voteResults: Record<string, string | null> | null
// votedOutUUID: string | null
// -> aggregated from Player.voteTargetUUID

// werewolfVotes: Record<string, string> | null
// werewolfVictim: string | null
// -> aggregated from Player.nightAction

// redLadySleepoverUUID: string | null
// -> aggregated from Player.nightAction

// cupidFirstLoverUUID: string | null
// cupidSecondLoverUUID: string | null
// -> aggregated from Player.nightAction

// witchUsedHealingPotion: boolean
// witchUsedKillingPotion: boolean