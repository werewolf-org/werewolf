import { Phase } from "@shared/phases.js";
import type { Game, Player } from "../../models.js";
import { getNominatedPlayers, getVotingWinner, isNominationsFinished, isVotingComplete } from "../selectors/vote.selectors.js";
import { getNextToWakeUp } from "../selectors/night.selectors.js";

const resolveLynchVoting = (game: Game): void => {
    const electedPlayer = getVotingWinner(game); 
    if(electedPlayer) {
        electedPlayer.isAlive = false;
        // check couple dying
        if(electedPlayer.lovePartner) {
            const lovePartner = game.players.find(p => p.playerUUID === electedPlayer.lovePartner);
            if(!lovePartner) throw new Error(`Player with ${electedPlayer.lovePartner} does not exist, cannot be a love partner`);
            lovePartner.isAlive = false;
        }
    }
    lynchDone(game, electedPlayer?.playerUUID ?? null);
}

const lynchDone = (game: Game, lastVotedOutUUID: string | null): void => {
    game.lynchDone = true;
    game.lastVotedOutUUID = lastVotedOutUUID;
    console.log(`Voting Resolved in Game ${game.gameId}. Player voted out: ${lastVotedOutUUID}`)
}

const startNight = (game: Game): void => {
    game.round = game.round + 1;
    game.phase = Phase.NIGHT;
    game.activeNightRole = getNextToWakeUp(game, true);
    game.players.forEach(p => p.voteTargetUUID = null);
    game.players.forEach(p => p.nominationUUID = null);
    game.lynchDone = false;
    if(!game.activeNightRole) throw new Error(`Game with ID ${game.gameId} cannot go to Night, no first night role`)
    game.players.forEach((player) => player.readyForNight = false);
}

const resolveSheriffVoting = (game: Game): void  => {
    const electedPlayer = getVotingWinner(game); 
    if(electedPlayer) game.sheriffUUID = electedPlayer.playerUUID;
    game.sheriffElectionDone = true;
    console.log(`Sheriff Voting Resolved in Game ${game.gameId}. New sheriff: ${electedPlayer?.playerUUID}`)
}

export const VoteHandler = {
    nominate(game: Game, player: Player, nominationUUID: string | false) {
        if(player.nominationUUID !== null) throw new Error(`Player with playerUUID ${player.playerUUID} already has a nomination`);
        const nominatedPlayers = getNominatedPlayers(game);
        if(typeof nominationUUID === 'string' && nominatedPlayers.includes(nominationUUID)) throw new Error(`Player with playerUUID ${player.playerUUID} wants to nominate ${nominationUUID} but this player was already nominated`);
        player.nominationUUID = nominationUUID;

        // fallback: nobody is nominated
        if(isNominationsFinished(game) && getNominatedPlayers(game).length === 0) lynchDone(game, null);
    },
    castLynchVote(game: Game, player: Player, targetUUID: string): void {
        if(player.voteTargetUUID) throw new Error(`Player with playerUUID ${player.playerUUID} already voted`);
        if(game.lynchDone) throw new Error(`Cannot vote in Game ${game.gameId} since lynch is already done`);
        const nominatedPlayers = getNominatedPlayers(game);
        if(!isNominationsFinished(game)) throw Error(`Game with Id ${game.gameId} has not finished with nominations, so vote cannot be cast`);
        if(!nominatedPlayers.includes(targetUUID)) throw new Error(`Player ${targetUUID} is not nominated, so voting for this player is not possible`)

        player.voteTargetUUID = targetUUID;

        const everyoneVoted: boolean = isVotingComplete(game);
        if (everyoneVoted) resolveLynchVoting(game);
    },
    castSheriffVote(game: Game, player: Player, targetUUID: string): void {
        if(player.voteTargetUUID) throw new Error(`Player with playerUUID ${player.playerUUID} already voted`);
        if(game.sheriffElectionDone) throw new Error(`Cannot vote in Game ${game.gameId} since lynch is already done!`);

        player.voteTargetUUID = targetUUID;

        const everyoneVoted: boolean = isVotingComplete(game);
        if (everyoneVoted) resolveSheriffVoting(game);
    },
    // AFTER LYNCH: everyone has to confirm voting results before night starts
    readyForNight(game: Game, player: Player): void {
        if(game.phase !== Phase.DAY) throw new Error(`Game ${game.gameId} is not currently in Day Phase (Phase: ${game.phase}), cannot confirm ready for night`);
        if(!player.isAlive) throw new Error(`Player with socketId ${player.socketId} is not alive anymore in game ${game.gameId}`);
        player.readyForNight = true;

        const alivePlayers = game.players.filter((player) => player.isAlive)
        if(alivePlayers.every(p => p.readyForNight)) startNight(game);
    },
    // AFTER SHERIFF VOTE: either sheriff or gm has to accept sheriff role / or confirm no sheriff was elected
    acceptSheriffRole(game: Game, player: Player): void {
        if(game.phase !== Phase.SHERIFF_ELECTION) throw new Error(`Game ${game.gameId} is not in SHERIFF_ELECTION phase.`);
        if(game.sheriffUUID) {
            if(player.playerUUID !== game.sheriffUUID) throw new Error(`Player is not the elected sheriff.`);
        } else {
            if(player.playerUUID !== game.managerUUID) throw new Error("Only GM can skip to day.");
        }

        game.phase = Phase.DAY;
        game.players.forEach((p) => p.voteTargetUUID = null);
    },
}