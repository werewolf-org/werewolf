import { describe, it, expect } from "vitest";
import { createMockGame, createMockPlayer, createGameWithPlayers, setRoles } from "./test-helpers.js";
import { Phase } from "@shared/phases.js";
import { Role } from "@shared/roles.js";
import {
  WerewolfHandler,
  SeerHandler,
  CupidHandler,
  WitchHandler,
  RedLadyHandler,
} from "../logic/handlers/role.handler.js";

describe("role.handler", () => {
  describe("WerewolfHandler.handleVote", () => {
    it("records werewolf vote and returns true when all wolves voted", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.WEREWOLF, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      WerewolfHandler.handleVote(game, game.players[0], "p2");
      const done = WerewolfHandler.handleVote(game, game.players[1], "p2");
      expect(done).toBe(true);
      expect(game.players[0].nightAction).toEqual({ targetUUID: "p2" });
    });

    it("returns false when not all wolves voted", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.WEREWOLF, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      const done = WerewolfHandler.handleVote(game, game.players[0], "p2");
      expect(done).toBe(false);
    });

    it("returns true when only one alive wolf exists", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      const done = WerewolfHandler.handleVote(game, game.players[0], "p1");
      expect(done).toBe(true);
    });

    it("does not count dead wolves", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.WEREWOLF, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      game.players[1].isAlive = false;
      const done = WerewolfHandler.handleVote(game, game.players[0], "p2");
      expect(done).toBe(true);
    });

    it("throws if a werewolf has no socketId", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      game.players[0].socketId = null;
      expect(() => WerewolfHandler.handleVote(game, game.players[0], "p1")).toThrow("does not have a socketId");
    });
  });

  describe("SeerHandler.handleRevealingRole", () => {
    it("records reveal target and role", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.SEER, Role.WEREWOLF]);
      game.phase = Phase.NIGHT;
      SeerHandler.handleRevealingRole(game, game.players[0], "p1");
      expect(game.players[0].nightAction).toEqual({
        revealUUID: "p1",
        revealedRole: Role.WEREWOLF,
      });
    });

    it("always returns false (manual confirm)", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.SEER, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      const result = SeerHandler.handleRevealingRole(game, game.players[0], "p1");
      expect(result).toBe(false);
    });

    it("throws when target does not exist", () => {
      const game = createGameWithPlayers(1);
      setRoles(game, [Role.SEER]);
      game.phase = Phase.NIGHT;
      expect(() => SeerHandler.handleRevealingRole(game, game.players[0], "fake")).toThrow("not found");
    });

    it("throws when target has no role", () => {
      const game = createGameWithPlayers(2);
      game.players[1].role = null;
      game.phase = Phase.NIGHT;
      expect(() => SeerHandler.handleRevealingRole(game, game.players[0], "p1")).toThrow("does not have a role");
    });
  });

  describe("SeerHandler.handleConfirm", () => {
    it("always returns true", () => {
      const game = createMockGame();
      expect(SeerHandler.handleConfirm(game)).toBe(true);
    });
  });

  describe("CupidHandler.handleBindLovers", () => {
    it("binds two players as lovers symmetrically", () => {
      const game = createGameWithPlayers(3);
      game.round = 0;
      game.phase = Phase.NIGHT;
      CupidHandler.handleBindLovers(game, game.players[0], "p1", "p2");
      expect(game.players[1].lovePartner).toBe("p2");
      expect(game.players[2].lovePartner).toBe("p1");
    });

    it("always returns false", () => {
      const game = createGameWithPlayers(3);
      game.round = 0;
      const result = CupidHandler.handleBindLovers(game, game.players[0], "p1", "p2");
      expect(result).toBe(false);
    });

    it("throws when round > 0", () => {
      const game = createGameWithPlayers(3);
      game.round = 1;
      expect(() => CupidHandler.handleBindLovers(game, game.players[0], "p1", "p2")).toThrow("already in round");
    });

    it("throws when first lover does not exist", () => {
      const game = createGameWithPlayers(2);
      game.round = 0;
      expect(() => CupidHandler.handleBindLovers(game, game.players[0], "fake", "p1")).toThrow("not found");
    });

    it("throws when second lover does not exist", () => {
      const game = createGameWithPlayers(2);
      game.round = 0;
      expect(() => CupidHandler.handleBindLovers(game, game.players[0], "p1", "fake")).toThrow("not found");
    });
  });

  describe("CupidHandler.handleLoverConfirmsBond", () => {
    it("returns false after first confirmation", () => {
      const game = createGameWithPlayers(2);
      game.activeNightRole = Role.CUPID;
      game.players[0].lovePartner = "p1";
      game.players[1].lovePartner = "p0";
      const result = CupidHandler.handleLoverConfirmsBond(game, game.players[0]);
      expect(result).toBe(false);
      expect(game.players[0].lovePartnerConfirmed).toBe(true);
    });

    it("returns true after second confirmation", () => {
      const game = createGameWithPlayers(2);
      game.activeNightRole = Role.CUPID;
      game.players[0].lovePartner = "p1";
      game.players[1].lovePartner = "p0";
      CupidHandler.handleLoverConfirmsBond(game, game.players[0]);
      const result = CupidHandler.handleLoverConfirmsBond(game, game.players[1]);
      expect(result).toBe(true);
    });

    it("throws when active role is not CUPID", () => {
      const game = createGameWithPlayers(2);
      game.activeNightRole = Role.WEREWOLF;
      game.players[0].lovePartner = "p1";
      expect(() => CupidHandler.handleLoverConfirmsBond(game, game.players[0])).toThrow("not CUPID");
    });

    it("throws when player is not a love partner", () => {
      const game = createGameWithPlayers(2);
      game.activeNightRole = Role.CUPID;
      expect(() => CupidHandler.handleLoverConfirmsBond(game, game.players[0])).toThrow("not part of the love partners");
    });
  });

  describe("WitchHandler.handlePotion", () => {
    it("records healing", () => {
      const game = createGameWithPlayers(1);
      game.phase = Phase.NIGHT;
      WitchHandler.handlePotion(game, game.players[0], true, null);
      expect(game.players[0].usedHealingPotion).toBe(true);
      expect(game.players[0].nightAction).toEqual({ heal: true });
    });

    it("records killing", () => {
      const game = createGameWithPlayers(1);
      game.phase = Phase.NIGHT;
      WitchHandler.handlePotion(game, game.players[0], null, "target-id");
      expect(game.players[0].usedKillingPotion).toBe(true);
      expect(game.players[0].nightAction).toEqual({ killUUID: "target-id" });
    });

    it("allows both heal and kill in same turn", () => {
      const game = createGameWithPlayers(1);
      game.phase = Phase.NIGHT;
      WitchHandler.handlePotion(game, game.players[0], true, "target-id");
      expect(game.players[0].usedHealingPotion).toBe(true);
      expect(game.players[0].usedKillingPotion).toBe(true);
      expect(game.players[0].nightAction).toEqual({ heal: true, killUUID: "target-id" });
    });

    it("returns false (manual confirm)", () => {
      const game = createGameWithPlayers(1);
      const result = WitchHandler.handlePotion(game, game.players[0], true, null);
      expect(result).toBe(false);
    });

    it("throws when no action provided", () => {
      const game = createGameWithPlayers(1);
      expect(() => WitchHandler.handlePotion(game, game.players[0], null, null)).toThrow("didn't use a Potion");
    });

    it("throws when healing potion already used", () => {
      const game = createGameWithPlayers(1);
      game.players[0].usedHealingPotion = true;
      expect(() => WitchHandler.handlePotion(game, game.players[0], true, null)).toThrow("already used healing potion");
    });

    it("throws when killing potion already used", () => {
      const game = createGameWithPlayers(1);
      game.players[0].usedKillingPotion = true;
      expect(() => WitchHandler.handlePotion(game, game.players[0], null, "target")).toThrow("already used killing potion");
    });
  });

  describe("WitchHandler.handleConfirm", () => {
    it("always returns true", () => {
      const game = createMockGame();
      const player = createMockPlayer();
      expect(WitchHandler.handleConfirm(game, player)).toBe(true);
    });
  });

  describe("RedLadyHandler.handleSleepover", () => {
    it("records sleepover target and returns true", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.RED_LADY, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      const result = RedLadyHandler.handleSleepover(game, game.players[0], "p1");
      expect(result).toBe(true);
      expect(game.players[0].nightAction).toEqual({ sleepoverUUID: "p1" });
    });
  });
});
