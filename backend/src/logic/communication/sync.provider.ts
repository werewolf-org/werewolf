import { Role } from "@shared/roles.js";
import type { Game, Player } from "../../models.js";
import { Phase } from "@shared/phases.js";
import { getWerewolfVictimUUID, getWerewolfVotes } from "../selectors/night.selectors.js";
import { getNominations, getVoteResult, isNominationsFinished } from "../selectors/vote.selectors.js";

export const getLocalPlayerState = (game: Game, player: Player): object => {
    const socketId: string | null = player.socketId;
    if(!socketId) throw new Error(`Player ${player.playerUUID} in Game ${game.gameId} does not have a socketID (${player.socketId})`);

    const redLadySleepoverUUID = player.role === Role.RED_LADY && player.nightAction ? (player.nightAction as any).sleepoverUUID : null;
    const seerRevealUUID = player.role === Role.SEER && player.nightAction ? (player.nightAction as any).revealUUID : null;
    const seerRevealRole = player.role === Role.SEER && player.nightAction ? (player.nightAction as any).revealedRole : null;

    // Aggregate werewolf votes and victim ONLY for Werewolves and Witch
    let werewolfVotes: Record<string, string> | null = null;
    let werewolfVictim: string | null = null;
    if (player.isAlive && player.role === Role.WEREWOLF) werewolfVotes = getWerewolfVotes(game);
    if (player.isAlive && (player.role === Role.WEREWOLF || player.role === Role.WITCH)) werewolfVictim = getWerewolfVictimUUID(game);

    const alivePlayers = game.players.filter(p => p.isAlive);
    const votedCount = alivePlayers.filter(p => p.voteTargetUUID !== null).length;
    const voteProgress = { voted: votedCount, total: alivePlayers.length };

    // Cupid confirmation status
    let cupidSelectedLovers = false;
    let cupidFirstLoverConfirmed = false;
    let cupidSecondLoverConfirmed = false;
    let cupidFirstLoverUUID = null;
    let cupidSecondLoverUUID = null;
    const cupid = game.players.find((p) => p.role == Role.CUPID);
    if(cupid && cupid.nightAction) {
        cupidSelectedLovers = true;
        const firstLover = game.players.find(p => p.playerUUID === (cupid.nightAction as any).firstPlayerUUID);
        const secondLover = game.players.find(p => p.playerUUID === (cupid.nightAction as any).secondPlayerUUID);
        if(player.playerUUID === firstLover?.playerUUID || player.playerUUID === secondLover?.playerUUID || player.playerUUID === cupid.playerUUID) {
            cupidFirstLoverConfirmed = firstLover?.lovePartnerConfirmed ?? false;
            cupidSecondLoverConfirmed = secondLover?.lovePartnerConfirmed ?? false;
            cupidFirstLoverUUID = firstLover?.playerUUID;
            cupidSecondLoverUUID = secondLover?.playerUUID;
        }
    }

    const localPlayerList = game.players.map(p => ({
        playerUUID: p.playerUUID,
        displayName: p.displayName,
        isSheriff: p.playerUUID === game.sheriffUUID,
        isAlive: p.isAlive,
        nomination: p.nominationUUID,
        role: (game.phase === Phase.GAME_OVER || !p.isAlive) ? p.role : null
    }));

    const localStatePatch: object = {
        gameId: game.gameId,
        playerUUID: player.playerUUID,
        phase: game.phase,
        activeNightRole: game.activeNightRole,
        players: localPlayerList,
        lynchDone: game.lynchDone,
        sheriffElectionDone: game.sheriffElectionDone,
        winningTeam: game.winningTeam,

        displayName: player.displayName,
        isManager: player.playerUUID === game.managerUUID,
        role: player.role,
        lovePartnerUUID: player.lovePartner,
        lovePartnerConfirmed: player.lovePartnerConfirmed,
        readyForNight: player.readyForNight,
        myVoteTargetUUID: player.voteTargetUUID,

        nominationsFinished: isNominationsFinished(game),
        voteResults: getVoteResult(game),
        voteProgress: voteProgress,
        votedOutUUID: game.lastVotedOutUUID,

        werewolfVotes: werewolfVotes,
        werewolfVictim: werewolfVictim,

        witchUsedHealingPotion: player.usedHealingPotion,
        witchUsedKillingPotion: player.usedKillingPotion,

        redLadySleepoverUUID: redLadySleepoverUUID,

        seerRevealUUID: seerRevealUUID,
        seerRevealRole: seerRevealRole,

        cupidSelectedLovers: cupidSelectedLovers,
        cupidFirstLoverUUID: cupidFirstLoverUUID,
        cupidSecondLoverUUID: cupidSecondLoverUUID,
        cupidFirstLoverConfirmed: cupidFirstLoverConfirmed,
        cupidSecondLoverConfirmed: cupidSecondLoverConfirmed,
    }
    return localStatePatch
}