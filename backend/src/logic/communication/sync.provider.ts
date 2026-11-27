import { Role } from "@shared/roles.js";
import type { Game, Player } from "../../models.js";
import { Phase } from "@shared/phases.js";
import type { Snapshot, SnapshotPlayer } from "@shared/snapshot.js";
import { getWerewolfVictimUUID, getWerewolfVotes } from "../selectors/night.selectors.js";
import { getVoteResult, isNominationsFinished, isVoteCast } from "../selectors/vote.selectors.js";

export const getLocalPlayerState = (game: Game, player: Player): Snapshot => {
    const socketId: string | null = player.socketId;
    if(!socketId) throw new Error(`Player ${player.playerUUID} in Game ${game.gameId} does not have a socketID (${player.socketId})`);
    const playerUUID = player.playerUUID;
    if(!playerUUID) throw new Error(`Player in Game ${game.gameId} does not have a playerUUID`);

    const redLadySleepoverUUID = player.role === Role.RED_LADY && player.nightAction ? player.nightAction.sleepoverUUID ?? null : null;
    const seerRevealUUID = player.role === Role.SEER && player.nightAction ? player.nightAction.revealUUID ?? null : null;
    const seerRevealRole = player.role === Role.SEER && player.nightAction ? player.nightAction.revealedRole ?? null : null;

    // Aggregate werewolf votes and victim ONLY for Werewolves and Witch
    let werewolfVotes: Record<string, string> | null = null;
    let werewolfVictim: string | null = null;
    if (player.isAlive && player.role === Role.WEREWOLF) werewolfVotes = getWerewolfVotes(game);
    if (player.isAlive && (player.role === Role.WEREWOLF || player.role === Role.WITCH)) werewolfVictim = getWerewolfVictimUUID(game);

    const alivePlayers = game.players.filter(p => p.isAlive);
    const votedCount = alivePlayers.filter(p => isVoteCast(p.voteTargetUUID)).length;
    const voteProgress = { voted: votedCount, total: alivePlayers.length };

    // Cupid confirmation status
    let cupidSelectedLovers = false;
    let cupidFirstLoverConfirmed = false;
    let cupidSecondLoverConfirmed = false;
    let cupidFirstLoverUUID: string | null = null;
    let cupidSecondLoverUUID: string | null = null;
    const cupid = game.players.find((p) => p.role === Role.CUPID);
    if(cupid && cupid.nightAction) {
        const firstLover = game.players.find(p => p.playerUUID === cupid.nightAction?.firstPlayerUUID);
        const secondLover = game.players.find(p => p.playerUUID === cupid.nightAction?.secondPlayerUUID);
        const isInvolved = player.playerUUID === firstLover?.playerUUID || player.playerUUID === secondLover?.playerUUID || player.playerUUID === cupid.playerUUID;
        // The game manager needs this to trigger the narration line, everyone else must not learn a Cupid exists
        if(isInvolved || player.playerUUID === game.managerUUID) cupidSelectedLovers = true;
        if(isInvolved) {
            cupidFirstLoverConfirmed = firstLover?.lovePartnerConfirmed ?? false;
            cupidSecondLoverConfirmed = secondLover?.lovePartnerConfirmed ?? false;
            cupidFirstLoverUUID = firstLover?.playerUUID ?? null;
            cupidSecondLoverUUID = secondLover?.playerUUID ?? null;
        }
    }

    const localPlayerList: SnapshotPlayer[] = game.players.map(p => {
        // A seat without an id cannot be represented on the wire; the invariant is
        // established at join time, so a violation here is a broken game, not a bad payload.
        if(!p.playerUUID) throw new Error(`Game ${game.gameId} has a player without a playerUUID`);
        return {
            playerUUID: p.playerUUID,
            displayName: p.displayName,
            isSheriff: p.playerUUID === game.sheriffUUID,
            isAlive: p.isAlive,
            nomination: p.nominationUUID,
            // Participation, not the choice. "Who are we still waiting for?" is public at a
            // table, and it is what lets the game master prod a phone that has gone quiet
            // without exposing a single ballot. The target stays in myVoteTargetUUID, private
            // to its owner, until voteResults resolves the stage.
            hasVoted: isVoteCast(p.voteTargetUUID),
            // Same rule for the end of the day: "who has not confirmed the night yet" is
            // participation, and a table that cannot name the missing phone has to ask around
            // the room. It says nothing about what anyone chose, because there is nothing to choose.
            readyForNight: p.readyForNight,
            role: (game.phase === Phase.GAME_OVER || !p.isAlive) ? p.role : null
        };
    });

    const localStatePatch: Snapshot = {
        gameId: game.gameId,
        playerUUID,
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
        myNominationUUID: player.nominationUUID,

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