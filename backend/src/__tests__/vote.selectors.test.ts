import { describe, it, expect } from "vitest";
import { createMockGame, createMockPlayer, createGameWithPlayers, setRoles } from "./test-helpers.js";
import { Phase } from "@shared/phases.js";
import { Role } from "@shared/roles.js";
import {
  isVotingComplete,
  getVoteResult,
  isNominationsFinished,
  getNominations,
  getNominatedPlayers,
  getVotingWinner,
} from "../logic/selectors/vote.selectors.js";

describe("vote.selectors", () => {
  describe("isVotingComplete", () => {
    it("returns true when all alive players have voted (string target)", () => {
      const game = createGameWithPlayers(3);
      game.players[0].voteTargetUUID = "p1";
      game.players[1].voteTargetUUID = "p0";
      game.players[2].voteTargetUUID = "p1";
      expect(isVotingComplete(game)).toBe(true);
    });

    it("returns true when all alive players have voted (false abstain)", () => {
      const game = createGameWithPlayers(2);
      game.players[0].voteTargetUUID = false;
      game.players[1].voteTargetUUID = false;
      expect(isVotingComplete(game)).toBe(true);
    });

    it("returns true when mix of string and false votes", () => {
      const game = createGameWithPlayers(3);
      game.players[0].voteTargetUUID = "p1";
      game.players[1].voteTargetUUID = false;
      game.players[2].voteTargetUUID = "p0";
      expect(isVotingComplete(game)).toBe(true);
    });

    it("returns false when at least one alive player has null voteTargetUUID", () => {
      const game = createGameWithPlayers(3);
      game.players[0].voteTargetUUID = "p1";
      game.players[1].voteTargetUUID = null;
      game.players[2].voteTargetUUID = "p0";
      expect(isVotingComplete(game)).toBe(false);
    });

    it("ignores dead players", () => {
      const game = createGameWithPlayers(3);
      game.players[0].voteTargetUUID = "p1";
      game.players[1].voteTargetUUID = null; // dead, ignored
      game.players[1].isAlive = false;
      game.players[2].voteTargetUUID = "p0";
      expect(isVotingComplete(game)).toBe(true);
    });

    it("returns true for empty alive player list (edge case)", () => {
      const game = createGameWithPlayers(1);
      game.players[0].isAlive = false;
      expect(isVotingComplete(game)).toBe(true);
    });
  });

  describe("getVoteResult", () => {
    it("returns null when voting is not complete", () => {
      const game = createGameWithPlayers(2);
      game.players[0].voteTargetUUID = "p1";
      game.players[1].voteTargetUUID = null;
      expect(getVoteResult(game)).toBeNull();
    });

    it("returns full vote map when complete including abstains", () => {
      const game = createGameWithPlayers(3);
      game.players[0].voteTargetUUID = "p1";
      game.players[1].voteTargetUUID = false;
      game.players[2].voteTargetUUID = "p1";
      expect(getVoteResult(game)).toEqual({
        p0: "p1",
        p1: false,
        p2: "p1",
      });
    });

    it("does not include players with null playerUUID", () => {
      const game = createGameWithPlayers(2);
      game.players[0].playerUUID = null;
      game.players[0].voteTargetUUID = "p1";
      game.players[1].voteTargetUUID = "p0";
      const result = getVoteResult(game);
      expect(result).toEqual({ p1: "p0" });
    });
  });

  describe("isNominationsFinished", () => {
    it("returns true when all alive players have nominated", () => {
      const game = createGameWithPlayers(3);
      game.players[0].nominationUUID = "p1";
      game.players[1].nominationUUID = false;
      game.players[2].nominationUUID = "p0";
      expect(isNominationsFinished(game)).toBe(true);
    });

    it("returns false when an alive player has null nominationUUID", () => {
      const game = createGameWithPlayers(2);
      game.players[0].nominationUUID = "p1";
      game.players[1].nominationUUID = null;
      expect(isNominationsFinished(game)).toBe(false);
    });

    it("ignores dead players", () => {
      const game = createGameWithPlayers(2);
      game.players[0].nominationUUID = "p1";
      game.players[1].nominationUUID = null;
      game.players[1].isAlive = false;
      expect(isNominationsFinished(game)).toBe(true);
    });
  });

  describe("getNominations", () => {
    it("returns map of playerUUID to nominationUUID for string nominations", () => {
      const game = createGameWithPlayers(3);
      game.players[0].nominationUUID = "p2";
      game.players[1].nominationUUID = false;
      game.players[2].nominationUUID = "p1";
      expect(getNominations(game)).toEqual({
        p0: "p2",
        p2: "p1",
      });
    });

    it("returns empty object when no nominations", () => {
      const game = createGameWithPlayers(2);
      game.players[0].nominationUUID = false;
      game.players[1].nominationUUID = false;
      expect(getNominations(game)).toEqual({});
    });

    it("returns null-keyed entries? no, filters null playerUUID", () => {
      const game = createGameWithPlayers(1);
      game.players[0].playerUUID = null;
      game.players[0].nominationUUID = "x";
      expect(getNominations(game)).toEqual({});
    });
  });

  describe("getNominatedPlayers", () => {
    it("returns list of all nominated player UUIDs (may include duplicates)", () => {
      const game = createGameWithPlayers(3);
      game.players[0].nominationUUID = "p2";
      game.players[1].nominationUUID = "p2"; // duplicate nomination
      game.players[2].nominationUUID = false;
      const result = getNominatedPlayers(game);
      expect(result).toEqual(["p2", "p2"]);
    });

    it("excludes false nominations", () => {
      const game = createGameWithPlayers(2);
      game.players[0].nominationUUID = false;
      game.players[1].nominationUUID = false;
      expect(getNominatedPlayers(game)).toEqual([]);
    });

    it("excludes null playerUUID entries", () => {
      const game = createGameWithPlayers(1);
      game.players[0].playerUUID = null;
      game.players[0].nominationUUID = "x";
      expect(getNominatedPlayers(game)).toEqual([]);
    });
  });

  describe("getVotingWinner", () => {
    it("returns player with clear majority", () => {
      const game = createGameWithPlayers(3);
      game.players[0].voteTargetUUID = "p1";
      game.players[1].voteTargetUUID = "p1";
      game.players[2].voteTargetUUID = "p0";
      const winner = getVotingWinner(game);
      expect(winner).not.toBeNull();
      expect(winner!.playerUUID).toBe("p1");
    });

    it("returns null when all alive players abstained", () => {
      const game = createGameWithPlayers(3);
      game.players[0].voteTargetUUID = false;
      game.players[1].voteTargetUUID = false;
      game.players[2].voteTargetUUID = false;
      expect(() => getVotingWinner(game)).toThrow("No votes present");
    });

    it("breaks tie with sheriff's vote if sheriff voted for one of the tied", () => {
      const game = createGameWithPlayers(4);
      game.sheriffUUID = "p0";
      game.players[0].voteTargetUUID = "p2";
      game.players[1].voteTargetUUID = "p2";
      game.players[2].voteTargetUUID = "p3";
      game.players[3].voteTargetUUID = "p3";
      const winner = getVotingWinner(game);
      expect(winner).not.toBeNull();
      expect(winner!.playerUUID).toBe("p2");
    });

    it("returns null on tie when sheriff did not vote for tied candidate", () => {
      const game = createGameWithPlayers(5);
      game.sheriffUUID = "p0";
      // Tie between p2 and p3 (2 votes each), sheriff voted for p1
      game.players[0].voteTargetUUID = "p1";
      game.players[1].voteTargetUUID = "p2";
      game.players[2].voteTargetUUID = "p2";
      game.players[3].voteTargetUUID = "p3";
      game.players[4].voteTargetUUID = "p3";
      const winner = getVotingWinner(game);
      expect(winner).toBeNull();
    });

    it("returns null on tie when sheriff is dead", () => {
      const game = createGameWithPlayers(5);
      game.sheriffUUID = "p0";
      game.players[0].isAlive = false;
      // Tie between p2 and p3 (2 votes each), sheriff is dead
      game.players[1].voteTargetUUID = "p2";
      game.players[2].voteTargetUUID = "p2";
      game.players[3].voteTargetUUID = "p3";
      game.players[4].voteTargetUUID = "p3";
      const winner = getVotingWinner(game);
      expect(winner).toBeNull();
    });

    it("ignores dead players' votes", () => {
      const game = createGameWithPlayers(3);
      game.players[0].isAlive = false;
      game.players[0].voteTargetUUID = "p1";
      game.players[1].voteTargetUUID = "p2";
      game.players[2].voteTargetUUID = "p2";
      const winner = getVotingWinner(game);
      expect(winner).not.toBeNull();
      expect(winner!.playerUUID).toBe("p2");
    });

    it("returns null when no alive players exist", () => {
      const game = createGameWithPlayers(2);
      game.players[0].isAlive = false;
      game.players[1].isAlive = false;
      expect(getVotingWinner(game)).toBeNull();
    });

    it("handles single alive player voting for themselves", () => {
      const game = createGameWithPlayers(2);
      game.players[0].isAlive = false;
      game.players[1].voteTargetUUID = "p1";
      const winner = getVotingWinner(game);
      expect(winner).not.toBeNull();
      expect(winner!.playerUUID).toBe("p1");
    });
  });
});
