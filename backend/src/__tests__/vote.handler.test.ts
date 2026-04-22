import { describe, it, expect } from "vitest";
import { createMockGame, createMockPlayer, createGameWithPlayers } from "./test-helpers.js";
import { Phase } from "@shared/phases.js";
import { Role } from "@shared/roles.js";
import { VoteHandler } from "../logic/handlers/vote.handler.js";

describe("vote.handler", () => {
  describe("nominate", () => {
    it("records a nomination successfully", () => {
      const game = createGameWithPlayers(3);
      VoteHandler.nominate(game, game.players[0], "p1");
      expect(game.players[0].nominationUUID).toBe("p1");
    });

    it("records false nomination (abstain)", () => {
      const game = createGameWithPlayers(2);
      VoteHandler.nominate(game, game.players[0], false);
      expect(game.players[0].nominationUUID).toBe(false);
    });

    it("throws when player has already nominated", () => {
      const game = createGameWithPlayers(2);
      VoteHandler.nominate(game, game.players[0], "p1");
      expect(() => VoteHandler.nominate(game, game.players[0], "p0")).toThrow("already has a nomination");
    });

    it("throws when nominating player who was already nominated by someone else", () => {
      const game = createGameWithPlayers(3);
      VoteHandler.nominate(game, game.players[0], "p2");
      expect(() => VoteHandler.nominate(game, game.players[1], "p2")).toThrow("already nominated");
    });

    it("allows different players to nominate different targets", () => {
      const game = createGameWithPlayers(3);
      VoteHandler.nominate(game, game.players[0], "p1");
      VoteHandler.nominate(game, game.players[1], "p2");
      expect(game.players[0].nominationUUID).toBe("p1");
      expect(game.players[1].nominationUUID).toBe("p2");
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
      expect(() => VoteHandler.castLynchVote(game, game.players[0], "p1")).toThrow("has not finished with nominations");
    });

    it("throws when target is not nominated", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.DAY;
      game.players[0].nominationUUID = "p0"; // self nomination
      game.players[1].nominationUUID = false;
      expect(() => VoteHandler.castLynchVote(game, game.players[0], "p1")).toThrow("not nominated");
    });

    it("throws when lynchDone is already true", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.DAY;
      game.players[0].nominationUUID = "p1";
      game.players[1].nominationUUID = false;
      game.lynchDone = true;
      expect(() => VoteHandler.castLynchVote(game, game.players[0], "p1")).toThrow("lynch is already done");
    });

    it("allows false (abstain) even if not in nominated list", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.DAY;
      game.players[0].nominationUUID = "p1";
      game.players[1].nominationUUID = false;
      VoteHandler.castLynchVote(game, game.players[0], false);
      expect(game.players[0].voteTargetUUID).toBe(false);
    });
  });

  describe("castSheriffVote", () => {
    it("records a vote for a nominated player", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.SHERIFF_ELECTION;
      game.players[0].nominationUUID = "p1";
      game.players[1].nominationUUID = false;
      game.players[2].nominationUUID = "p1";
      VoteHandler.castSheriffVote(game, game.players[0], "p1");
      expect(game.players[0].voteTargetUUID).toBe("p1");
      expect(game.sheriffElectionDone).toBe(false);
    });

    it("records abstain vote (false)", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.SHERIFF_ELECTION;
      game.players[0].nominationUUID = "p1";
      game.players[1].nominationUUID = "p0";
      VoteHandler.castSheriffVote(game, game.players[0], false);
      expect(game.players[0].voteTargetUUID).toBe(false);
    });

    it("resolves election when last player votes", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.SHERIFF_ELECTION;
      game.players[0].nominationUUID = "p1";
      game.players[1].nominationUUID = false;
      game.players[2].nominationUUID = "p1";
      VoteHandler.castSheriffVote(game, game.players[0], "p1");
      VoteHandler.castSheriffVote(game, game.players[1], "p1");
      VoteHandler.castSheriffVote(game, game.players[2], "p1");
      expect(game.sheriffElectionDone).toBe(true);
      expect(game.sheriffUUID).toBe("p1");
    });

    it("resolves sheriff election with abstain-only votes to no sheriff", () => {
      const game = createGameWithPlayers(4);
      game.phase = Phase.SHERIFF_ELECTION;
      game.players[0].nominationUUID = false;
      game.players[1].nominationUUID = false;
      game.players[2].nominationUUID = false;
      game.players[3].nominationUUID = false;
      VoteHandler.castSheriffVote(game, game.players[0], false);
      VoteHandler.castSheriffVote(game, game.players[1], false);
      VoteHandler.castSheriffVote(game, game.players[2], false);
      VoteHandler.castSheriffVote(game, game.players[3], false); // triggers

      expect(game.sheriffElectionDone).toBe(true);
      expect(game.sheriffUUID).toBeNull();
    });

    it("throws when player already voted", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.SHERIFF_ELECTION;
      game.players[0].nominationUUID = "p1";
      game.players[1].nominationUUID = false;
      VoteHandler.castSheriffVote(game, game.players[0], "p1");
      expect(() => VoteHandler.castSheriffVote(game, game.players[0], "p1")).toThrow("already voted");
    });

    it("throws when nominations not finished", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.SHERIFF_ELECTION;
      game.players[0].nominationUUID = "p1";
      // players[1] nominationUUID is null
      expect(() => VoteHandler.castSheriffVote(game, game.players[0], "p1")).toThrow("has not finished with nominations");
    });

    it("throws when target is not nominated", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.SHERIFF_ELECTION;
      game.players[0].nominationUUID = "p0";
      game.players[1].nominationUUID = false;
      expect(() => VoteHandler.castSheriffVote(game, game.players[0], "p1")).toThrow("not nominated");
    });

    it("throws when election already done", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.SHERIFF_ELECTION;
      game.players[0].nominationUUID = "p1";
      game.players[1].nominationUUID = false;
      game.sheriffElectionDone = true;
      expect(() => VoteHandler.castSheriffVote(game, game.players[0], "p1")).toThrow("already done");
    });
  });

  describe("readyForNight", () => {
    it("marks player ready", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.DAY;
      VoteHandler.readyForNight(game, game.players[0]);
      expect(game.players[0].readyForNight).toBe(true);
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
      game.players[0].voteTargetUUID = "p1";
      game.players[1].nominationUUID = "p0";
      VoteHandler.acceptSheriffRole(game, game.players[1]);
      expect(game.players[0].voteTargetUUID).toBeNull();
      expect(game.players[1].nominationUUID).toBeNull();
    });
  });

  describe("acceptSheriffRole", () => {
    it("elected sheriff accepts and transitions to DAY", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.SHERIFF_ELECTION;
      game.sheriffUUID = "p1";
      game.players[0].voteTargetUUID = "p1";
      game.players[1].voteTargetUUID = "p1";
      game.players[2].voteTargetUUID = "p1";
      VoteHandler.acceptSheriffRole(game, game.players[1]);
      expect(game.phase).toBe(Phase.DAY);
      expect(game.players[0].voteTargetUUID).toBeNull();
    });

    it("GM skips when no sheriff elected", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.SHERIFF_ELECTION;
      game.managerUUID = "p0";
      game.players[0].voteTargetUUID = false;
      game.players[1].voteTargetUUID = false;
      VoteHandler.acceptSheriffRole(game, game.players[0]);
      expect(game.phase).toBe(Phase.DAY);
    });

    it("throws when non-sheriff tries to accept after election", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.SHERIFF_ELECTION;
      game.sheriffUUID = "p1";
      expect(() => VoteHandler.acceptSheriffRole(game, game.players[0])).toThrow("not the elected sheriff");
    });

    it("throws when non-GM tries to skip when no sheriff", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.SHERIFF_ELECTION;
      game.managerUUID = "p0";
      expect(() => VoteHandler.acceptSheriffRole(game, game.players[1])).toThrow("Only GM");
    });

    it("throws when not in sheriff election phase", () => {
      const game = createGameWithPlayers(1);
      game.phase = Phase.DAY;
      expect(() => VoteHandler.acceptSheriffRole(game, game.players[0])).toThrow("not in SHERIFF_ELECTION");
    });
  });
});
