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
// The message is read by a human: no UUIDs, no internal field names.
const assertLivingTarget = (game: Game, targetUUID: string | false, action: string): void => {
    if(typeof targetUUID !== "string") return;
    const target = game.players.find((p) => p.playerUUID === targetUUID);
    if(!target || !target.isAlive) throw new Error(`That player is not available, so ${action} is not possible.`);
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
// the day ends without a candidate. Nominations only exist for the daily lynch; the sheriff
// election has no nomination stage (every living player is a candidate by default).
const resolveEmptyNominations = (game: Game): boolean => {
    if(game.phase !== Phase.DAY) return false;
    if(!isNominationsFinished(game) || getNominatedPlayers(game).length > 0) return false;
    lynchDone(game, null);
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
        // Nominations are the first half of the daily lynch. The sheriff election used to
        // reuse this pipeline ("nominate, then vote") and no longer does: every living player
        // is on the ballot from the start.
        if(game.phase !== Phase.DAY) throw new Error("Nominations are closed.");
        if(isAlreadyCast(player.nominationUUID)) throw new Error("You already nominated someone today.");
        const nomination = normalizeTarget(nominationUUID);
        // Several players may name the same person: a nomination is a public statement of
        // suspicion, and agreeing with somebody is the common case. Making the target exclusive
        // turned that into a first-come-first-served race and a rejection. The trial ballot
        // dedupes the candidates, so a second changes the set not at all and the count visibly.
        assertLivingTarget(game, nomination, "nominating");
        player.nominationUUID = nomination;

        // fallback: nobody is nominated
        resolveEmptyNominations(game);
    },
    castLynchVote(game: Game, player: Player, targetUUID: string | false | null | undefined): void {
        if(isAlreadyCast(player.voteTargetUUID)) throw new Error("You already voted in this trial.");
        if(game.lynchDone) throw new Error("The trial is already over.");
        if(!isNominationsFinished(game)) throw Error("The trial has not started yet.");
        const target = normalizeTarget(targetUUID);
        const nominatedPlayers = getNominatedPlayers(game);
        if(typeof target === "string" && !nominatedPlayers.includes(target)) throw new Error("That player is not on trial.")

        player.voteTargetUUID = target;

        const everyoneVoted: boolean = isVotingComplete(game);
        if (everyoneVoted) resolveLynchVoting(game);
    },
    castSheriffVote(game: Game, player: Player, targetUUID: string | false | null | undefined): void {
        if(isAlreadyCast(player.voteTargetUUID)) throw new Error("You already voted in this election.");
        if(game.sheriffElectionDone) throw new Error("The election is already over.");
        // Direct election: no nomination stage, so every living player is a candidate.
        // The target only has to exist and be alive, otherwise a ballot entry could point at
        // a corpse that never appears in any candidate list and the vote silently voids.
        const target = normalizeTarget(targetUUID);
        assertLivingTarget(game, target, "voting for this player");

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
                // Direct election: there is no nomination stage to skip, only missing ballots.
                fillMissingVotes(game);
                resolveSheriffVoting(game);
                return;
            }
            acceptSheriffResult(game);
        }
    },
}
