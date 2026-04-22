import { describe, it, expect } from "vitest";
import { createMockGame, createMockPlayer, createGameWithPlayers, setRoles } from "./test-helpers.js";
import { Role } from "@shared/roles.js";
import { Phase } from "@shared/phases.js";
import {
  getWerewolfVotes,
  getWerewolfVictimUUID,
  getNextToWakeUp,
  checkPlayerNightRole,
} from "../logic/selectors/night.selectors.js";

describe("night.selectors", () => {
  describe("getWerewolfVotes", () => {
    it("returns null when no werewolf has voted", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER]);
      expect(getWerewolfVotes(game)).toBeNull();
    });

    it("returns map of alive werewolf votes", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.WEREWOLF, Role.VILLAGER]);
      game.players[0].nightAction = { targetUUID: "p2" };
      game.players[1].nightAction = { targetUUID: "p2" };
      expect(getWerewolfVotes(game)).toEqual({
        p0: "p2",
        p1: "p2",
      });
    });

    it("ignores dead werewolves", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.WEREWOLF, Role.VILLAGER]);
      game.players[0].isAlive = false;
      game.players[0].nightAction = { targetUUID: "p2" };
      game.players[1].nightAction = { targetUUID: "p2" };
      expect(getWerewolfVotes(game)).toEqual({ p1: "p2" });
    });

    it("ignores werewolves without nightAction", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER]);
      game.players[0].nightAction = null;
      expect(getWerewolfVotes(game)).toBeNull();
    });

    it("ignores werewolves with empty targetUUID", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER]);
      game.players[0].nightAction = { targetUUID: "" };
      expect(getWerewolfVotes(game)).toBeNull();
    });

    it("ignores non-werewolf players with nightAction targetUUID", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.VILLAGER, Role.WEREWOLF]);
      game.players[0].nightAction = { targetUUID: "p1" };
      game.players[1].nightAction = { targetUUID: "p0" };
      expect(getWerewolfVotes(game)).toEqual({ p1: "p0" });
    });
  });

  describe("getWerewolfVictimUUID", () => {
    it("returns null when no werewolf has voted", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER]);
      expect(getWerewolfVictimUUID(game)).toBeNull();
    });

    it("returns consensus target when all wolves vote same", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.WEREWOLF, Role.VILLAGER]);
      game.players[0].nightAction = { targetUUID: "p2" };
      game.players[1].nightAction = { targetUUID: "p2" };
      expect(getWerewolfVictimUUID(game)).toBe("p2");
    });

    it("returns null when wolves split votes", () => {
      const game = createGameWithPlayers(4);
      setRoles(game, [Role.WEREWOLF, Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER]);
      game.players[0].nightAction = { targetUUID: "p2" };
      game.players[1].nightAction = { targetUUID: "p3" };
      expect(getWerewolfVictimUUID(game)).toBeNull();
    });

    it("returns target when only one alive wolf votes", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.WEREWOLF, Role.VILLAGER]);
      game.players[1].isAlive = false;
      game.players[0].nightAction = { targetUUID: "p2" };
      expect(getWerewolfVictimUUID(game)).toBe("p2");
    });

    it("returns null when one alive wolf has not voted yet", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.WEREWOLF, Role.VILLAGER]);
      game.players[0].nightAction = { targetUUID: "p2" };
      game.players[1].nightAction = null;
      expect(getWerewolfVictimUUID(game)).toBeNull();
    });

    it("returns null for empty targetUUID consensus", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER]);
      game.players[0].nightAction = { targetUUID: "" };
      expect(getWerewolfVictimUUID(game)).toBeNull();
    });

    it("returns null when wolves vote unanimously for empty string", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.WEREWOLF, Role.VILLAGER]);
      game.players[0].nightAction = { targetUUID: "" };
      game.players[1].nightAction = { targetUUID: "" };
      expect(getWerewolfVictimUUID(game)).toBeNull();
    });
  });

  describe("getNextToWakeUp", () => {
    it("returns first role in night order at round 0", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.CUPID, Role.VILLAGER, Role.SEER]);
      game.round = 0;
      expect(getNextToWakeUp(game, true)).toBe(Role.CUPID);
    });

    it("skips onlyFirstNight roles when round > 0", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.CUPID, Role.SEER, Role.VILLAGER]);
      game.round = 1;
      expect(getNextToWakeUp(game, true)).toBe(Role.SEER);
    });

    it("skips roles where wakesUp is false", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.VILLAGER, Role.WEREWOLF]);
      expect(getNextToWakeUp(game, true)).toBe(Role.WEREWOLF);
    });

    it("skips roles where all players are dead", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.SEER, Role.WEREWOLF, Role.VILLAGER]);
      game.players[0].isAlive = false;
      expect(getNextToWakeUp(game, true)).toBe(Role.WEREWOLF);
    });

    it("returns next role after current activeNightRole", () => {
      const game = createGameWithPlayers(3);
      // CUPID(1), WEREWOLF(3), SEER(4) sorted order at round 0
      setRoles(game, [Role.CUPID, Role.SEER, Role.WEREWOLF]);
      game.round = 0;
      game.activeNightRole = Role.CUPID;
      expect(getNextToWakeUp(game, false)).toBe(Role.WEREWOLF);
    });

    it("returns null when current role is last", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER]);
      game.activeNightRole = Role.WEREWOLF;
      expect(getNextToWakeUp(game, false)).toBeNull();
    });

    it("returns null when no roles qualify", () => {
      const game = createGameWithPlayers(1);
      setRoles(game, [Role.VILLAGER]);
      expect(getNextToWakeUp(game, true)).toBeNull();
    });

    it("returns null on second call when only one night role exists", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.SEER, Role.VILLAGER]);
      game.activeNightRole = Role.SEER;
      expect(getNextToWakeUp(game, false)).toBeNull();
    });
  });

  describe("checkPlayerNightRole", () => {
    it("throws when game is not in NIGHT phase", () => {
      const game = createMockGame({ phase: Phase.DAY });
      const player = createMockPlayer();
      expect(() => checkPlayerNightRole(game, player, Role.SEER)).toThrow(
        "not current in Night Phase"
      );
    });

    it("does not throw with role=null (used for Cupid lover confirms)", () => {
      const game = createMockGame({ phase: Phase.NIGHT });
      const player = createMockPlayer();
      expect(() => checkPlayerNightRole(game, player, null)).not.toThrow();
    });

    it("throws when player's role does not match required role", () => {
      const game = createMockGame({ phase: Phase.NIGHT });
      const player = createMockPlayer({ role: Role.VILLAGER });
      expect(() => checkPlayerNightRole(game, player, Role.SEER)).toThrow(
        "does not have the correct role"
      );
    });

    it("throws when player's role does not wake up at night", () => {
      const game = createMockGame({ phase: Phase.NIGHT });
      const player = createMockPlayer({ role: Role.VILLAGER });
      expect(() => checkPlayerNightRole(game, player, Role.VILLAGER)).toThrow(
        "doesnt wake up in the night"
      );
    });

    it("passes when player has correct role that wakes up", () => {
      const game = createMockGame({ phase: Phase.NIGHT });
      const player = createMockPlayer({ role: Role.SEER });
      expect(() => checkPlayerNightRole(game, player, Role.SEER)).not.toThrow();
    });
  });
});
