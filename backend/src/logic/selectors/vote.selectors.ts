import type { Game, Player } from "../../models.js";

// A cast is either a target UUID or an explicit abstain (false).
// `undefined` means "nothing was sent" (socket.io drops undefined keys) and must not count as a cast.
export const isVoteCast = (target: string | false | null | undefined): boolean =>
    target === false || typeof target === "string";

// Players whose action is required to complete a stage: every living player.
// A disconnected player (socketId === null) still counts, so a phone that locks mid-vote blocks
// completion on purpose and the game manager has to acknowledge it with the force-advance escape hatch.
export const getActingPlayers = (game: Game): Player[] =>
    game.players.filter(p => p.isAlive);

export const isVotingComplete = (game: Game): boolean => {
    return getActingPlayers(game).every(p => isVoteCast(p.voteTargetUUID));
}

export const getVoteResult = (game: Game): Record<string, string | false | null> | null => {
    if(!isVotingComplete(game)) return null;
    return Object.fromEntries(
            game.players
                .filter(p => p.playerUUID !== null)
                .map(p => [p.playerUUID, p.voteTargetUUID])
        );
}
export const isNominationsFinished = (game: Game): boolean => {
    return getActingPlayers(game).every(p => isVoteCast(p.nominationUUID));
}
export const getNominations = (game: Game): Record<string, string> | null => {
    return Object.fromEntries(
        game.players
            .filter(p => p.playerUUID !== null && p.nominationUUID)
            .map(p => [p.playerUUID, p.nominationUUID])
    )
}
// The candidates on trial, in seat order, once each.
// Several players may nominate the same person (a "second"), so the raw nomination list can
// contain duplicates; the trial ballot must not.
export const getNominatedPlayers = (game: Game): string[] => {
  const targets = game.players.flatMap(p =>
    (p.playerUUID !== null && typeof p.nominationUUID === 'string')
      ? [p.nominationUUID]
      : []
  );
  return [...new Set(targets)];
}
export const getVotingWinner = (game: Game): Player | null  => {
    const votes: Record<string, number> = {}
    const alivePlayers = game.players.filter((player) => player.isAlive)
    if(alivePlayers.length === 0) return null;
    for (const player of alivePlayers) {
        if(player.voteTargetUUID) votes[player.voteTargetUUID] = (votes[player.voteTargetUUID] ?? 0) + 1;
    }
    const entries = Object.entries(votes);
    if (entries.length === 0) return null;

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
