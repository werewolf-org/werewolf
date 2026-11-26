import { Phase } from "@shared/phases.js";
import type { Game, Player } from "../../models.js";
import { getActingPlayers, getNominatedPlayers, getVotingWinner, isNominationsFinished, isVoteCast, isVotingComplete } from "../selectors/vote.selectors.js";
import { getNextToWakeUp } from "../selectors/night.selectors.js";

// Socket payloads are untyped and socket.io drops keys with an `undefined` value.
// Normalise every payload to the two states the game understands: a target UUID or an explicit abstain (false).
const normalizeTarget = (targetUUID: unknown): string | false => {
    // A missing field or explicit null/false means "abstain". Anything else that is not a
    // string is a malformed payload: silently treating an object or a number as an abstain
    // would consume the player's only vote without them ever choosing anything.
    if(targetUUID === undefined || targetUUID === null || targetUUID === false) return false;
    if(typeof targetUUID === "string") return targetUUID;
    throw new Error(`Invalid vote target: expected a player id or false, got ${typeof targetUUID}`);
};

const isAlreadyCast = (value: string | false | null | undefined): boolean =>
    value !== null && value !== undefined;

// A target must be a living player of this game, otherwise the candidate shows up in no list
// and can never win the vote (the stage would silently resolve to "nobody lynched").
const assertLivingTarget = (game: Game, targetUUID: string | false, action: string): void => {
    if(typeof targetUUID !== "string") return;
    const target = game.players.find((p) => p.playerUUID === targetUUID);
    if(!target || !target.isAlive) throw new Error(`Player ${targetUUID} is not an alive player of game ${game.gameId}, so ${action} is not possible`);
}

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
    handleSheriffDeath(game);
}

const lynchDone = (game: Game, lastVotedOutUUID: string | null): void => {
    game.lynchDone = true;
    game.lastVotedOutUUID = lastVotedOutUUID;
    console.log(`Voting Resolved in Game ${game.gameId}. Player voted out: ${lastVotedOutUUID}`)
}

const startNight = (game: Game): void => {
    // Resolve the first night role before touching the state, so a missing night role cannot leave
    // the game in NIGHT with no active role (half-advanced). The round must be advanced in the same
    // breath: `getNextToWakeUp` decides "first night only" roles (cupid) from `game.round`, so
    // querying with the old round would schedule the cupid again on night 2.
    const nextRound = game.round + 1;
    const nextActiveRole = getNextToWakeUp({ ...game, round: nextRound }, true);
    if(!nextActiveRole) throw new Error(`Game with ID ${game.gameId} cannot go to Night, no first night role`)
    game.round = nextRound;
    game.phase = Phase.NIGHT;
    game.activeNightRole = nextActiveRole;
    game.players.forEach(p => p.voteTargetUUID = null);
    game.players.forEach(p => p.nominationUUID = null);
    game.lynchDone = false;
    game.players.forEach((player) => player.readyForNight = false);
}

const resolveSheriffVoting = (game: Game): void  => {
    const electedPlayer = getVotingWinner(game); 
    if(electedPlayer) game.sheriffUUID = electedPlayer.playerUUID;
    game.sheriffElectionDone = true;
    console.log(`Sheriff Voting Resolved in Game ${game.gameId}. New sheriff: ${electedPlayer?.playerUUID}`)
}

// Nomination round resolution: once every living player has nominated and nobody was nominated,
// the stage ends without a candidate (no lynch / no sheriff).
const resolveEmptyNominations = (game: Game): boolean => {
    if(!isNominationsFinished(game) || getNominatedPlayers(game).length > 0) return false;
    if(game.phase === Phase.DAY) lynchDone(game, null);
    else if(game.phase === Phase.SHERIFF_ELECTION) {
        game.sheriffUUID = null;
        game.sheriffElectionDone = true;
    }
    return true;
}

// Sheriff badge rule: the badge never stays with a corpse.
// If the sheriff died, the badge is cleared and the village plays on without one
// (no tie-break, so a tied lynch means nobody is lynched).
// Call this after any death resolution, e.g. from the night-death path in night.handler.ts.
export const handleSheriffDeath = (game: Game): void => {
    if(!game.sheriffUUID) return;
    const sheriff = game.players.find((p) => p.playerUUID === game.sheriffUUID);
    if(sheriff?.isAlive) return;
    console.log(`Sheriff ${game.sheriffUUID} died in Game ${game.gameId}. Badge cleared.`)
    game.sheriffUUID = null;
}

const acceptSheriffResult = (game: Game): void => {
    game.phase = Phase.DAY;
    game.sheriffElectionDone = true;
    game.players.forEach((p) => {
        p.voteTargetUUID = null;
        p.nominationUUID = null;
    });
}

const fillMissingNominations = (game: Game): void => {
    game.players.filter((p) => p.isAlive).forEach((p) => {
        if(!isVoteCast(p.nominationUUID)) p.nominationUUID = false;
    });
}

const fillMissingVotes = (game: Game): void => {
    game.players.filter((p) => p.isAlive).forEach((p) => {
        if(!isVoteCast(p.voteTargetUUID)) p.voteTargetUUID = false;
    });
}

export const VoteHandler = {
    nominate(game: Game, player: Player, nominationUUID: string | false | null | undefined) {
        if(isAlreadyCast(player.nominationUUID)) throw new Error(`Player with playerUUID ${player.playerUUID} already has a nomination`);
        const nomination = normalizeTarget(nominationUUID);
        const nominatedPlayers = getNominatedPlayers(game);
        if(typeof nomination === "string" && nominatedPlayers.includes(nomination)) throw new Error(`Player with playerUUID ${player.playerUUID} wants to nominate ${nomination} but this player was already nominated`);
        assertLivingTarget(game, nomination, "nominating this player");
        player.nominationUUID = nomination;

        // fallback: nobody is nominated
        resolveEmptyNominations(game);
    },
    castLynchVote(game: Game, player: Player, targetUUID: string | false | null | undefined): void {
        if(isAlreadyCast(player.voteTargetUUID)) throw new Error(`Player with playerUUID ${player.playerUUID} already voted`);
        if(game.lynchDone) throw new Error(`Cannot vote in Game ${game.gameId} since lynch is already done`);
        if(!isNominationsFinished(game)) throw Error(`Game with Id ${game.gameId} has not finished with nominations, so vote cannot be cast`);
        const target = normalizeTarget(targetUUID);
        const nominatedPlayers = getNominatedPlayers(game);
        if(typeof target === "string" && !nominatedPlayers.includes(target)) throw new Error(`Player ${target} is not nominated, so voting for this player is not possible`)

        player.voteTargetUUID = target;

        const everyoneVoted: boolean = isVotingComplete(game);
        if (everyoneVoted) resolveLynchVoting(game);
    },
    castSheriffVote(game: Game, player: Player, targetUUID: string | false | null | undefined): void {
        if(isAlreadyCast(player.voteTargetUUID)) throw new Error(`Player with playerUUID ${player.playerUUID} already voted`);
        if(game.sheriffElectionDone) throw new Error(`Cannot vote in Game ${game.gameId} since election is already done!`);
        if(!isNominationsFinished(game)) throw Error(`Game with Id ${game.gameId} has not finished with nominations, so vote cannot be cast`);
        const target = normalizeTarget(targetUUID);
        const nominatedPlayers = getNominatedPlayers(game);
        if(typeof target === "string" && !nominatedPlayers.includes(target)) throw new Error(`Player ${target} is not nominated, so voting for this player is not possible`)

        player.voteTargetUUID = target;

        const everyoneVoted: boolean = isVotingComplete(game);
        if (everyoneVoted) resolveSheriffVoting(game);
    },
    // AFTER LYNCH: everyone has to confirm voting results before night starts
    readyForNight(game: Game, player: Player): void {
        if(game.phase !== Phase.DAY) throw new Error(`Game ${game.gameId} is not currently in Day Phase (Phase: ${game.phase}), cannot confirm ready for night`);
        if(!player.isAlive) throw new Error(`Player with socketId ${player.socketId} is not alive anymore in game ${game.gameId}`);
        if(!game.lynchDone) throw new Error(`Game ${game.gameId} has not resolved the lynch yet, cannot confirm ready for night`);
        player.readyForNight = true;

        const actingPlayers = getActingPlayers(game);
        if(actingPlayers.every(p => p.readyForNight)) startNight(game);
    },
    // AFTER SHERIFF VOTE: either sheriff or gm has to accept sheriff role / or confirm no sheriff was elected
    acceptSheriffRole(game: Game, player: Player): void {
        if(game.phase !== Phase.SHERIFF_ELECTION) throw new Error(`Game ${game.gameId} is not in SHERIFF_ELECTION phase.`);
        if(!game.sheriffElectionDone) throw new Error(`Sheriff election in game ${game.gameId} is not resolved yet, cannot accept the sheriff role.`);
        if(game.sheriffUUID) {
            // the GM can continue when the elected sheriff never acts
            if(player.playerUUID !== game.sheriffUUID && player.playerUUID !== game.managerUUID) throw new Error(`Player is not the elected sheriff.`);
        } else {
            if(player.playerUUID !== game.managerUUID) throw new Error("Only GM can skip to day.");
        }

        acceptSheriffResult(game);
    },
    // GM-only escape hatch. Advances exactly one stage and never leaves a half-resolved stage:
    // missing nominations/votes are filled with an explicit abstain (false) and the regular
    // resolution functions finish the stage.
    forceAdvance(game: Game): void {
        if(game.phase === Phase.DAY) {
            if(!isNominationsFinished(game)) {
                fillMissingNominations(game);
                resolveEmptyNominations(game);
                return;
            }
            if(!game.lynchDone) {
                fillMissingVotes(game);
                resolveLynchVoting(game);
                return;
            }
            startNight(game);
            return;
        }
        if(game.phase === Phase.SHERIFF_ELECTION) {
            if(!game.sheriffElectionDone) {
                if(!isNominationsFinished(game)) fillMissingNominations(game);
                if(resolveEmptyNominations(game)) return;
                fillMissingVotes(game);
                resolveSheriffVoting(game);
                return;
            }
            acceptSheriffResult(game);
        }
    },
}
