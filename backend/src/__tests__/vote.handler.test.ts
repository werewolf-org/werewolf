import { describe, it, expect } from "vitest";
import { createMockGame, createMockPlayer, createGameWithPlayers, setRoles } from "./test-helpers.js";
import { Phase } from "@shared/phases.js";
import { Role } from "@shared/roles.js";
import { VoteHandler, handleSheriffDeath } from "../logic/handlers/vote.handler.js";
import { isNominationsFinished, isVotingComplete, getNominatedPlayers } from "../logic/selectors/vote.selectors.js";

describe("vote.handler", () => {
  describe("nominate", () => {
    it("records a nomination successfully", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.DAY;
      VoteHandler.nominate(game, game.players[0], "p1");
      expect(game.players[0].nominationUUID).toBe("p1");
    });

    it("records false nomination (abstain)", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.DAY;
      VoteHandler.nominate(game, game.players[0], false);
      expect(game.players[0].nominationUUID).toBe(false);
    });

    it("throws when player has already nominated", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.DAY;
      VoteHandler.nominate(game, game.players[0], "p1");
      expect(() => VoteHandler.nominate(game, game.players[0], "p0")).toThrow("already nominated");
    });

    it("allows several players to nominate the same target, a second", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.DAY;
      VoteHandler.nominate(game, game.players[0], "p2");
      VoteHandler.nominate(game, game.players[1], "p2");
      expect(game.players[0].nominationUUID).toBe("p2");
      expect(game.players[1].nominationUUID).toBe("p2");
      // Two nominations, one candidate on the trial ballot.
      expect(getNominatedPlayers(game)).toEqual(["p2"]);
    });

    it("allows different players to nominate different targets", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.DAY;
      VoteHandler.nominate(game, game.players[0], "p1");
      VoteHandler.nominate(game, game.players[1], "p2");
      expect(game.players[0].nominationUUID).toBe("p1");
      expect(game.players[1].nominationUUID).toBe("p2");
    });

    it("throws outside DAY, so the sheriff election has no nomination stage", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.SHERIFF_ELECTION;
      expect(() => VoteHandler.nominate(game, game.players[0], "p1")).toThrow("Nominations are closed");
      expect(game.players[0].nominationUUID).toBeNull();
    });

    it("sets lynchDone(null) when all alive players nominated but nobody was nominated", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.DAY;
      VoteHandler.nominate(game, game.players[0], false);
      expect(game.lynchDone).toBe(false);
      VoteHandler.nominate(game, game.players[1], false);
      expect(game.lynchDone).toBe(true);
      expect(game.lastVotedOutUUID).toBeNull();
    });

    it("does not trigger lynchDone when all players finish nominating different targets", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.DAY;
      VoteHandler.nominate(game, game.players[0], "p2");
      VoteHandler.nominate(game, game.players[1], "p0");
      VoteHandler.nominate(game, game.players[2], false);
      expect(game.lynchDone).toBe(false);
    });

    it("rejects a dead candidate (B13)", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.DAY;
      game.players[2].isAlive = false;
      expect(() => VoteHandler.nominate(game, game.players[0], "p2")).toThrow("not available");
      expect(game.players[0].nominationUUID).toBeNull();
    });

    it("rejects an unknown candidate (B13)", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.DAY;
      expect(() => VoteHandler.nominate(game, game.players[0], "does-not-exist")).toThrow("not available");
      expect(game.players[0].nominationUUID).toBeNull();
      expect(isNominationsFinished(game)).toBe(false);
    });

    it("normalises an undefined payload to abstain (B14)", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.DAY;
      VoteHandler.nominate(game, game.players[0], undefined as any);
      expect(game.players[0].nominationUUID).toBe(false);
      expect(isNominationsFinished(game)).toBe(false);
    });
  });

  describe("castLynchVote", () => {
    it("records a vote for a nominated player", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.DAY;
      game.players[0].nominationUUID = "p1";
      game.players[1].nominationUUID = false;
      game.players[2].nominationUUID = "p1";
      VoteHandler.castLynchVote(game, game.players[0], "p1");
      expect(game.players[0].voteTargetUUID).toBe("p1");
      expect(game.lynchDone).toBe(false);
    });

    it("votes abstain (false)", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.DAY;
      game.players[0].nominationUUID = "p1";
      game.players[1].nominationUUID = "p0";
      VoteHandler.castLynchVote(game, game.players[0], false);
      expect(game.players[0].voteTargetUUID).toBe(false);
    });

    it("resolves voting when last player votes", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.DAY;
      game.players[0].nominationUUID = "p1";
      game.players[1].nominationUUID = false;
      game.players[2].nominationUUID = "p1";
      VoteHandler.castLynchVote(game, game.players[0], "p1");
      VoteHandler.castLynchVote(game, game.players[1], "p1");
      VoteHandler.castLynchVote(game, game.players[2], "p1");
      expect(game.lynchDone).toBe(true);
      expect(game.lastVotedOutUUID).toBe("p1");
    });

    it("does not resolve when not all players voted", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.DAY;
      game.players[0].nominationUUID = "p1";
      game.players[1].nominationUUID = false;
      game.players[2].nominationUUID = "p1";
      VoteHandler.castLynchVote(game, game.players[0], "p1");
      expect(game.lynchDone).toBe(false);
    });

    it("kills lover when voted out player has a love partner", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.DAY;
      game.players[0].nominationUUID = "p1";
      game.players[1].nominationUUID = false;
      game.players[2].nominationUUID = "p1";
      game.players[1].lovePartner = "p2";
      game.players[2].lovePartner = "p1";
      VoteHandler.castLynchVote(game, game.players[0], "p1");
      VoteHandler.castLynchVote(game, game.players[1], false);
      VoteHandler.castLynchVote(game, game.players[2], "p1");
      expect(game.lynchDone).toBe(true);
      expect(game.players[1].isAlive).toBe(false);
      expect(game.players[2].isAlive).toBe(false);
    });

    it("throws when player already voted", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.DAY;
      game.players[0].nominationUUID = "p1";
      game.players[1].nominationUUID = "p0";
      VoteHandler.castLynchVote(game, game.players[0], "p1");
      expect(() => VoteHandler.castLynchVote(game, game.players[0], "p1")).toThrow("already voted");
    });

    it("throws when nominations not finished", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.DAY;
      game.players[0].nominationUUID = "p1";
      // players[1] nominationUUID is null
      expect(() => VoteHandler.castLynchVote(game, game.players[0], "p1")).toThrow("has not started yet");
    });

    it("throws when target is not nominated", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.DAY;
      game.players[0].nominationUUID = "p0"; // self nomination
      game.players[1].nominationUUID = false;
      expect(() => VoteHandler.castLynchVote(game, game.players[0], "p1")).toThrow("not on trial");
    });

    it("throws when lynchDone is already true", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.DAY;
      game.players[0].nominationUUID = "p1";
      game.players[1].nominationUUID = false;
      game.lynchDone = true;
      expect(() => VoteHandler.castLynchVote(game, game.players[0], "p1")).toThrow("already over");
    });

    it("allows false (abstain) even if not in nominated list", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.DAY;
      game.players[0].nominationUUID = "p1";
      game.players[1].nominationUUID = false;
      VoteHandler.castLynchVote(game, game.players[0], false);
      expect(game.players[0].voteTargetUUID).toBe(false);
    });

    it("normalises an undefined payload to abstain (B14)", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.DAY;
      game.players[0].nominationUUID = "p1";
      game.players[1].nominationUUID = false;
      VoteHandler.castLynchVote(game, game.players[0], undefined as any);
      expect(game.players[0].voteTargetUUID).toBe(false);
      expect(isVotingComplete(game)).toBe(false);
    });

    it("a disconnected player still blocks the lynch until the GM force-advances", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.DAY;
      game.players[0].nominationUUID = "p1";
      game.players[1].nominationUUID = false;
      game.players[2].nominationUUID = "p1";
      game.players[2].socketId = null; // disconnected, has not voted yet
      VoteHandler.castLynchVote(game, game.players[0], "p1");
      VoteHandler.castLynchVote(game, game.players[1], "p1");
      expect(isVotingComplete(game)).toBe(false);
      expect(game.lynchDone).toBe(false);

      VoteHandler.forceAdvance(game);
      expect(game.lynchDone).toBe(true);
      expect(game.lastVotedOutUUID).toBe("p1");
    });
  });

  describe("castSheriffVote", () => {
    it("records a direct vote for any living player, with no nomination stage", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.SHERIFF_ELECTION;
      VoteHandler.castSheriffVote(game, game.players[0], "p1");
      expect(game.players[0].voteTargetUUID).toBe("p1");
      expect(game.sheriffElectionDone).toBe(false);
      // Nobody nominated anybody: the direct election does not need it.
      expect(isNominationsFinished(game)).toBe(false);
    });

    it("records abstain vote (false)", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.SHERIFF_ELECTION;
      VoteHandler.castSheriffVote(game, game.players[0], false);
      expect(game.players[0].voteTargetUUID).toBe(false);
    });

    it("resolves election when last player votes", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.SHERIFF_ELECTION;
      VoteHandler.castSheriffVote(game, game.players[0], "p1");
      VoteHandler.castSheriffVote(game, game.players[1], "p1");
      VoteHandler.castSheriffVote(game, game.players[2], "p1");
      expect(game.sheriffElectionDone).toBe(true);
      expect(game.sheriffUUID).toBe("p1");
    });

    it("resolves sheriff election with abstain-only votes to no sheriff", () => {
      const game = createGameWithPlayers(4);
      game.phase = Phase.SHERIFF_ELECTION;
      VoteHandler.castSheriffVote(game, game.players[0], false);
      VoteHandler.castSheriffVote(game, game.players[1], false);
      VoteHandler.castSheriffVote(game, game.players[2], false);
      VoteHandler.castSheriffVote(game, game.players[3], false); // triggers

      expect(game.sheriffElectionDone).toBe(true);
      expect(game.sheriffUUID).toBeNull();
    });

    it("elects nobody when the direct vote is tied", () => {
      const game = createGameWithPlayers(4);
      game.phase = Phase.SHERIFF_ELECTION;
      // 2-2: there is no incumbent sheriff to break the tie.
      VoteHandler.castSheriffVote(game, game.players[0], "p1");
      VoteHandler.castSheriffVote(game, game.players[1], "p0");
      VoteHandler.castSheriffVote(game, game.players[2], "p1");
      VoteHandler.castSheriffVote(game, game.players[3], "p0"); // triggers

      expect(game.sheriffElectionDone).toBe(true);
      expect(game.sheriffUUID).toBeNull();
    });

    it("throws when player already voted", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.SHERIFF_ELECTION;
      VoteHandler.castSheriffVote(game, game.players[0], "p1");
      expect(() => VoteHandler.castSheriffVote(game, game.players[0], "p1")).toThrow("already voted");
    });

    it("accepts a living player who was never nominated", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.SHERIFF_ELECTION;
      VoteHandler.castSheriffVote(game, game.players[0], "p1");
      expect(game.players[0].voteTargetUUID).toBe("p1");
    });

    it("rejects a dead player as the target", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.SHERIFF_ELECTION;
      game.players[2].isAlive = false;
      expect(() => VoteHandler.castSheriffVote(game, game.players[0], "p2")).toThrow("not available");
      expect(game.players[0].voteTargetUUID).toBeNull();
    });

    it("rejects an unknown player as the target", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.SHERIFF_ELECTION;
      expect(() => VoteHandler.castSheriffVote(game, game.players[0], "does-not-exist")).toThrow("not available");
      expect(game.players[0].voteTargetUUID).toBeNull();
    });

    it("throws when election already done", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.SHERIFF_ELECTION;
      game.sheriffElectionDone = true;
      expect(() => VoteHandler.castSheriffVote(game, game.players[0], "p1")).toThrow("already over");
    });

    it("normalises an undefined payload to abstain (B14)", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.SHERIFF_ELECTION;
      VoteHandler.castSheriffVote(game, game.players[0], undefined as any);
      expect(game.players[0].voteTargetUUID).toBe(false);
      expect(game.sheriffElectionDone).toBe(false);
    });

    it("a disconnected player still blocks the election until the GM force-advances", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.SHERIFF_ELECTION;
      game.players[2].socketId = null; // disconnected, has not voted yet
      VoteHandler.castSheriffVote(game, game.players[0], "p1");
      VoteHandler.castSheriffVote(game, game.players[1], "p1");
      expect(isVotingComplete(game)).toBe(false);
      expect(game.sheriffElectionDone).toBe(false);

      VoteHandler.forceAdvance(game);
      expect(game.sheriffElectionDone).toBe(true);
      expect(game.sheriffUUID).toBe("p1");
    });
  });

  describe("readyForNight", () => {
    it("marks player ready", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.DAY;
      game.lynchDone = true;
      VoteHandler.readyForNight(game, game.players[0]);
      expect(game.players[0].readyForNight).toBe(true);
      expect(game.phase).toBe(Phase.DAY);
    });

    it("throws when the lynch is not done yet (B12)", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.DAY;
      game.lynchDone = false;
      expect(() => VoteHandler.readyForNight(game, game.players[0])).toThrow("has not resolved the lynch yet");
      expect(game.players[0].readyForNight).toBe(false);
      expect(game.phase).toBe(Phase.DAY);
    });

    it("does not end the day when all alive players are ready during nominations (B12)", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER]);
      game.phase = Phase.DAY;
      game.players.forEach(p => p.nominationUUID = false);
      game.lynchDone = false;

      game.players.forEach(p => {
        expect(() => VoteHandler.readyForNight(game, p)).toThrow("has not resolved the lynch yet");
      });
      expect(game.phase).toBe(Phase.DAY);
    });

    it("transitions to NIGHT when all alive players ready", () => {
      const game = createGameWithPlayers(2);
      // Need a werewolf for night order
      game.players[0].role = Role.WEREWOLF;
      game.players[1].role = Role.VILLAGER;
      game.phase = Phase.DAY;
      game.lynchDone = true;
      VoteHandler.readyForNight(game, game.players[0]);
      VoteHandler.readyForNight(game, game.players[1]);
      expect(game.phase).toBe(Phase.NIGHT);
      expect(game.round).toBe(1);
    });

    it("throws when game not in DAY phase", () => {
      const game = createGameWithPlayers(1);
      game.phase = Phase.NIGHT;
      expect(() => VoteHandler.readyForNight(game, game.players[0])).toThrow("not currently in Day Phase");
    });

    it("throws when player is dead", () => {
      const game = createGameWithPlayers(1);
      game.phase = Phase.DAY;
      game.players[0].isAlive = false;
      expect(() => VoteHandler.readyForNight(game, game.players[0])).toThrow("not alive");
    });

    it("does not transition if dead player is only one not ready", () => {
      const game = createGameWithPlayers(3);
      game.players[0].role = Role.WEREWOLF;
      game.players[1].role = Role.VILLAGER;
      game.players[2].role = Role.VILLAGER;
      game.phase = Phase.DAY;
      game.lynchDone = true;
      game.players[0].readyForNight = true;
      game.players[1].readyForNight = false;
      game.players[2].isAlive = false;
      VoteHandler.readyForNight(game, game.players[1]);
      expect(game.phase).toBe(Phase.NIGHT);
    });

    it("resets votes and nominations on night transition", () => {
      const game = createGameWithPlayers(2);
      game.players[0].role = Role.WEREWOLF;
      game.players[1].role = Role.VILLAGER;
      game.phase = Phase.DAY;
      game.lynchDone = true;
      game.players[0].voteTargetUUID = "p1";
      game.players[1].nominationUUID = "p0";
      VoteHandler.readyForNight(game, game.players[0]);
      VoteHandler.readyForNight(game, game.players[1]);
      expect(game.players[0].voteTargetUUID).toBeNull();
      expect(game.players[1].nominationUUID).toBeNull();
    });

    it("resets votes and nominations on sheriff acceptance", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.SHERIFF_ELECTION;
      game.managerUUID = "p0";
      game.sheriffUUID = "p1";
      game.sheriffElectionDone = true;
      game.players[0].voteTargetUUID = "p1";
      game.players[1].nominationUUID = "p0";
      VoteHandler.acceptSheriffRole(game, game.players[1]);
      expect(game.players[0].voteTargetUUID).toBeNull();
      expect(game.players[1].nominationUUID).toBeNull();
    });

    it("a disconnected player blocks the night transition until the GM force-advances", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER]);
      game.phase = Phase.DAY;
      game.players.forEach(p => p.nominationUUID = false);
      game.lynchDone = true;
      game.players[2].socketId = null; // disconnected, never confirms
      VoteHandler.readyForNight(game, game.players[0]);
      VoteHandler.readyForNight(game, game.players[1]);
      expect(game.phase).toBe(Phase.DAY);

      VoteHandler.forceAdvance(game);
      expect(game.phase).toBe(Phase.NIGHT);
      expect(game.round).toBe(1);
    });
  });

  describe("acceptSheriffRole", () => {
    it("elected sheriff accepts and transitions to DAY", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.SHERIFF_ELECTION;
      game.sheriffUUID = "p1";
      game.sheriffElectionDone = true;
      game.players[0].voteTargetUUID = "p1";
      game.players[1].voteTargetUUID = "p1";
      game.players[2].voteTargetUUID = "p1";
      VoteHandler.acceptSheriffRole(game, game.players[1]);
      expect(game.phase).toBe(Phase.DAY);
      expect(game.players[0].voteTargetUUID).toBeNull();
    });

    it("GM can continue when a sheriff was elected but never accepts (B21)", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.SHERIFF_ELECTION;
      game.managerUUID = "p0";
      game.sheriffUUID = "p1";
      game.sheriffElectionDone = true;
      VoteHandler.acceptSheriffRole(game, game.players[0]);
      expect(game.phase).toBe(Phase.DAY);
      expect(game.sheriffUUID).toBe("p1");
      expect(game.sheriffElectionDone).toBe(true);
    });

    it("GM skips when no sheriff elected", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.SHERIFF_ELECTION;
      game.managerUUID = "p0";
      game.sheriffElectionDone = true;
      game.players[0].voteTargetUUID = false;
      game.players[1].voteTargetUUID = false;
      VoteHandler.acceptSheriffRole(game, game.players[0]);
      expect(game.phase).toBe(Phase.DAY);
      expect(game.sheriffElectionDone).toBe(true);
    });

    it("throws when the election is not resolved yet (B4)", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.SHERIFF_ELECTION;
      game.managerUUID = "p0";
      game.players[0].nominationUUID = "p1";
      expect(() => VoteHandler.acceptSheriffRole(game, game.players[0])).toThrow("is not resolved yet");
      expect(game.phase).toBe(Phase.SHERIFF_ELECTION);
      expect(game.sheriffElectionDone).toBe(false);
    });

    it("throws when non-sheriff tries to accept after election", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.SHERIFF_ELECTION;
      game.sheriffUUID = "p1";
      game.sheriffElectionDone = true;
      expect(() => VoteHandler.acceptSheriffRole(game, game.players[0])).toThrow("not the elected sheriff");
    });

    it("throws when non-GM tries to skip when no sheriff", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.SHERIFF_ELECTION;
      game.managerUUID = "p0";
      game.sheriffElectionDone = true;
      expect(() => VoteHandler.acceptSheriffRole(game, game.players[1])).toThrow("Only GM");
    });

    it("throws when not in sheriff election phase", () => {
      const game = createGameWithPlayers(1);
      game.phase = Phase.DAY;
      expect(() => VoteHandler.acceptSheriffRole(game, game.players[0])).toThrow("not in SHERIFF_ELECTION");
    });
  });

  describe("handleSheriffDeath (B23)", () => {
    it("clears the badge when the sheriff died", () => {
      const game = createGameWithPlayers(3);
      game.sheriffUUID = "p1";
      game.players[1].isAlive = false;
      handleSheriffDeath(game);
      expect(game.sheriffUUID).toBeNull();
    });

    it("keeps the badge while the sheriff is alive", () => {
      const game = createGameWithPlayers(3);
      game.sheriffUUID = "p1";
      handleSheriffDeath(game);
      expect(game.sheriffUUID).toBe("p1");
    });

    it("is a no-op when nobody holds the badge", () => {
      const game = createGameWithPlayers(2);
      game.players[0].isAlive = false;
      expect(() => handleSheriffDeath(game)).not.toThrow();
      handleSheriffDeath(game);
      expect(game.sheriffUUID).toBeNull();
    });

    it("clears the badge when the sheriff is voted out", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.DAY;
      game.sheriffUUID = "p1";
      game.players[0].nominationUUID = "p1";
      game.players[1].nominationUUID = false;
      game.players[2].nominationUUID = false;
      game.players.forEach(p => VoteHandler.castLynchVote(game, p, "p1"));
      expect(game.players[1].isAlive).toBe(false);
      expect(game.lastVotedOutUUID).toBe("p1");
      expect(game.sheriffUUID).toBeNull();
    });
  });

  describe("forceAdvance (B20)", () => {
    it("finishes the nominations stage with abstains and leaves the trial open", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.DAY;
      VoteHandler.nominate(game, game.players[0], "p1");

      VoteHandler.forceAdvance(game);

      expect(game.players[1].nominationUUID).toBe(false);
      expect(game.players[2].nominationUUID).toBe(false);
      expect(isNominationsFinished(game)).toBe(true);
      expect(game.lynchDone).toBe(false);
      expect(game.phase).toBe(Phase.DAY);
      // exactly one step: nobody voted yet
      expect(game.players[1].voteTargetUUID).toBeNull();
    });

    it("resolves a nomination stage without any candidate to 'nobody lynched'", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.DAY;

      VoteHandler.forceAdvance(game);

      expect(isNominationsFinished(game)).toBe(true);
      expect(game.lynchDone).toBe(true);
      expect(game.lastVotedOutUUID).toBeNull();
    });

    it("resolves the trial stage with missing votes as abstains", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.DAY;
      game.players[0].nominationUUID = "p1";
      game.players[1].nominationUUID = false;
      game.players[2].nominationUUID = false;
      VoteHandler.castLynchVote(game, game.players[0], "p1");

      VoteHandler.forceAdvance(game);

      expect(game.players[1].voteTargetUUID).toBe(false);
      expect(game.players[2].voteTargetUUID).toBe(false);
      expect(game.lynchDone).toBe(true);
      expect(game.lastVotedOutUUID).toBe("p1");
      expect(game.players[1].isAlive).toBe(false);
      expect(game.phase).toBe(Phase.DAY);
    });

    it("starts the night after the lynch is done", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER]);
      game.phase = Phase.DAY;
      game.players.forEach(p => p.nominationUUID = false);
      game.lynchDone = true;
      game.players.forEach(p => p.readyForNight = true);

      VoteHandler.forceAdvance(game);

      expect(game.phase).toBe(Phase.NIGHT);
      expect(game.round).toBe(1);
      expect(game.activeNightRole).toBe(Role.WEREWOLF);
      expect(game.lynchDone).toBe(false);
      expect(game.players.every(p => !p.readyForNight)).toBe(true);
    });

    it("does nothing outside DAY and SHERIFF_ELECTION", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      game.round = 2;

      VoteHandler.forceAdvance(game);

      expect(game.phase).toBe(Phase.NIGHT);
      expect(game.round).toBe(2);
    });

    it("resolves an unresolved sheriff election without a candidate as 'no sheriff'", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.SHERIFF_ELECTION;
      game.managerUUID = "p0";

      VoteHandler.forceAdvance(game);

      // Direct election: there is no nomination stage to finish.
      expect(isNominationsFinished(game)).toBe(false);
      expect(game.sheriffElectionDone).toBe(true);
      expect(game.sheriffUUID).toBeNull();
      // one step only: still waiting for the GM to accept/continue
      expect(game.phase).toBe(Phase.SHERIFF_ELECTION);
    });

    it("resolves an unresolved sheriff election with a candidate", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.SHERIFF_ELECTION;
      VoteHandler.castSheriffVote(game, game.players[0], "p1");

      VoteHandler.forceAdvance(game);

      expect(game.sheriffElectionDone).toBe(true);
      expect(game.sheriffUUID).toBe("p1");
      expect(game.phase).toBe(Phase.SHERIFF_ELECTION);
    });

    it("moves a resolved but unaccepted sheriff election to DAY", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.SHERIFF_ELECTION;
      game.sheriffElectionDone = true;
      game.sheriffUUID = "p1";
      game.players[0].voteTargetUUID = "p1";
      game.players[0].nominationUUID = "p1";

      VoteHandler.forceAdvance(game);

      expect(game.phase).toBe(Phase.DAY);
      expect(game.sheriffElectionDone).toBe(true);
      expect(game.sheriffUUID).toBe("p1");
      expect(game.players[0].voteTargetUUID).toBeNull();
      expect(game.players[0].nominationUUID).toBeNull();
    });
  });
});
