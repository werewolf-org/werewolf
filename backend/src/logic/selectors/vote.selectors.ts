import type { Game, Player } from "../../models.js";

export const isVotingComplete = (game: Game): boolean => {
    const alivePlayers = game.players.filter(p => p.isAlive);
    return alivePlayers.every(p => p.voteTargetUUID !== null);
}

export const getVoteResult = (game: Game): Record<string, string | null> | null => {
    if(!isVotingComplete(game)) return null;
    return Object.fromEntries(
            game.players
                .filter(p => p.playerUUID !== null)
                .map(p => [p.playerUUID, p.voteTargetUUID])
        );
}
export const isNominationsFinished = (game: Game): boolean => {
    const alivePlayers = game.players.filter(p => p.isAlive);
    return alivePlayers.every(p => p.nominationUUID !== null);
}
export const getNominations = (game: Game): Record<string, string> | null => {
    return Object.fromEntries(
        game.players
            .filter(p => p.playerUUID !== null && p.nominationUUID)
            .map(p => [p.playerUUID, p.nominationUUID])
    )
}
export const getNominatedPlayers = (game: Game): string[] => {
  return game.players.flatMap(p => 
    (p.playerUUID !== null && typeof p.nominationUUID === 'string') 
      ? [p.nominationUUID] 
      : []
  );
}
export const getVotingWinner = (game: Game): Player | null  => {
    const votes: Record<string, number> = {}
    const alivePlayers = game.players.filter((player) => player.isAlive)
    if(alivePlayers.length === 0) return null;
    for (const player of alivePlayers) {
        if(player.voteTargetUUID) votes[player.voteTargetUUID] = (votes[player.voteTargetUUID] ?? 0) + 1;
    }
    const entries = Object.entries(votes);
    if (entries.length === 0) throw new Error("No votes present");

    const maxCount = Math.max(...Object.entries(votes).map(([, count]) => count));
    const electedPlayers = entries
        .filter(([, count]) => count === maxCount)
        .map(([uuid]) => uuid); 

    let electedPlayerUUID: string | null = null;
    if(electedPlayers.length === 1) electedPlayerUUID = electedPlayers[0] ?? null;
    else if(electedPlayers.length > 1) {
        const sheriff = alivePlayers.find((player) => player.playerUUID === game.sheriffUUID);
        if(sheriff && sheriff.isAlive && sheriff.voteTargetUUID && electedPlayers.includes(sheriff.voteTargetUUID)) electedPlayerUUID = sheriff.voteTargetUUID;
    }

    const electedPlayer = alivePlayers.find((player) => player.playerUUID === electedPlayerUUID) ?? null;
    return electedPlayer;
}