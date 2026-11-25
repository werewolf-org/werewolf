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

    it("throws when voting for a dead player", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.WEREWOLF, Role.VILLAGER]);
      game.players[2].isAlive = false;
      expect(() => WerewolfHandler.handleVote(game, game.players[0], "p2")).toThrow("already dead");
      expect(game.players[0].nightAction).toBeNull();
    });

    it("throws when voting for a non-existent player", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER]);
      expect(() => WerewolfHandler.handleVote(game, game.players[0], "nobody")).toThrow("not found");
    });

    it("throws when a werewolf votes for themselves", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER]);
      expect(() => WerewolfHandler.handleVote(game, game.players[0], "p0")).toThrow("cannot vote for themselves");
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

    it("throws on a second reveal in the same night", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.SEER, Role.WEREWOLF, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      SeerHandler.handleRevealingRole(game, game.players[0], "p1");
      expect(() => SeerHandler.handleRevealingRole(game, game.players[0], "p2")).toThrow("already revealed a role this night");
      expect(game.players[0].nightAction).toEqual({
        revealUUID: "p1",
        revealedRole: Role.WEREWOLF,
      });
    });

    it("throws when revealing a dead player", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.SEER, Role.WEREWOLF]);
      game.players[1].isAlive = false;
      expect(() => SeerHandler.handleRevealingRole(game, game.players[0], "p1")).toThrow("already dead");
    });

    it("allows revealing themselves (pointless but harmless)", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.SEER, Role.WEREWOLF]);
      expect(() => SeerHandler.handleRevealingRole(game, game.players[0], "p0")).not.toThrow();
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

    it("throws when binding a player to themselves", () => {
      const game = createGameWithPlayers(3);
      game.round = 0;
      expect(() => CupidHandler.handleBindLovers(game, game.players[0], "p1", "p1")).toThrow("cannot be bound to themselves");
      expect(game.players[1].lovePartner).toBeNull();
      expect(game.players[0].nightAction).toBeNull();
    });

    it("throws when binding a dead player", () => {
      const game = createGameWithPlayers(3);
      game.round = 0;
      game.players[1].isAlive = false;
      expect(() => CupidHandler.handleBindLovers(game, game.players[0], "p1", "p2")).toThrow("already dead");
      expect(game.players.every(p => p.lovePartner === null)).toBe(true);
    });

    it("rejects a second binding in the same night", () => {
      const game = createGameWithPlayers(4);
      game.round = 0;
      CupidHandler.handleBindLovers(game, game.players[0], "p1", "p2");
      expect(() => CupidHandler.handleBindLovers(game, game.players[0], "p2", "p3")).toThrow("already bound lovers this night");
      expect(game.players[1].lovePartner).toBe("p2");
      expect(game.players[2].lovePartner).toBe("p1");
      expect(game.players[3].lovePartner).toBeNull();
    });

    it("never creates two couples", () => {
      const game = createGameWithPlayers(5);
      game.round = 0;
      CupidHandler.handleBindLovers(game, game.players[0], "p1", "p2");
      expect(() => CupidHandler.handleBindLovers(game, game.players[0], "p3", "p4")).toThrow();
      const lovers = game.players.filter(p => p.lovePartner);
      expect(lovers.map(p => p.playerUUID).sort()).toEqual(["p1", "p2"]);
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

    it("throws when a dead lover tries to confirm", () => {
      const game = createGameWithPlayers(2);
      game.activeNightRole = Role.CUPID;
      game.players[0].lovePartner = "p1";
      game.players[1].lovePartner = "p0";
      game.players[0].isAlive = false;
      expect(() => CupidHandler.handleLoverConfirmsBond(game, game.players[0])).toThrow("is dead");
      expect(game.players[0].lovePartnerConfirmed).toBe(false);
    });
  });

  describe("WitchHandler.handlePotion", () => {
    it("records healing", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.WEREWOLF, Role.WITCH]);
      game.phase = Phase.NIGHT;
      game.players[0].nightAction = { targetUUID: "p1" }; // werewolf victim
      WitchHandler.handlePotion(game, game.players[1], true, null);
      expect(game.players[1].usedHealingPotion).toBe(true);
      expect(game.players[1].nightAction).toEqual({ heal: true });
    });

    it("records killing", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.VILLAGER, Role.WITCH, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      WitchHandler.handlePotion(game, game.players[1], null, "p0");
      expect(game.players[1].usedKillingPotion).toBe(true);
      expect(game.players[1].nightAction).toEqual({ killUUID: "p0" });
    });

    it("allows both heal and kill in same turn", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.WITCH, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      game.players[0].nightAction = { targetUUID: "p2" }; // werewolf victim
      WitchHandler.handlePotion(game, game.players[1], true, "p0");
      expect(game.players[1].usedHealingPotion).toBe(true);
      expect(game.players[1].usedKillingPotion).toBe(true);
      expect(game.players[1].nightAction).toEqual({ heal: true, killUUID: "p0" });
    });

    it("returns false (manual confirm)", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.WEREWOLF, Role.WITCH]);
      game.players[0].nightAction = { targetUUID: "p1" };
      const result = WitchHandler.handlePotion(game, game.players[1], true, null);
      expect(result).toBe(false);
    });

    it("throws when no action provided", () => {
      const game = createGameWithPlayers(1);
      expect(() => WitchHandler.handlePotion(game, game.players[0], null, null)).toThrow("didn't use a Potion");
    });

    it("throws when healing potion already used", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.WEREWOLF, Role.WITCH]);
      game.players[0].nightAction = { targetUUID: "p1" };
      game.players[1].usedHealingPotion = true;
      expect(() => WitchHandler.handlePotion(game, game.players[1], true, null)).toThrow("already used healing potion");
    });

    it("throws when killing potion already used", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.VILLAGER, Role.WITCH]);
      game.players[1].usedKillingPotion = true;
      expect(() => WitchHandler.handlePotion(game, game.players[1], null, "p0")).toThrow("already used killing potion");
    });

    it("does not consume the healing potion when there is no werewolf victim", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.VILLAGER, Role.WITCH]);
      game.phase = Phase.NIGHT;
      expect(() => WitchHandler.handlePotion(game, game.players[1], true, null)).toThrow("no werewolf victim");
      expect(game.players[1].usedHealingPotion).toBe(false);
      expect(game.players[1].nightAction).toBeNull();
    });

    it("throws when poisoning a non-existent UUID without consuming potions", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.VILLAGER, Role.WITCH]);
      expect(() => WitchHandler.handlePotion(game, game.players[1], null, "does-not-exist")).toThrow("not found");
      expect(game.players[1].usedKillingPotion).toBe(false);
      expect(game.players[1].nightAction).toBeNull();
    });

    it("throws when poisoning a dead player", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.VILLAGER, Role.WITCH, Role.VILLAGER]);
      game.players[0].isAlive = false;
      expect(() => WitchHandler.handlePotion(game, game.players[1], null, "p0")).toThrow("already dead");
      expect(game.players[1].usedKillingPotion).toBe(false);
    });

    it("throws when poisoning themselves", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.VILLAGER, Role.WITCH]);
      expect(() => WitchHandler.handlePotion(game, game.players[1], null, "p1")).toThrow("cannot poison themselves");
      expect(game.players[1].usedKillingPotion).toBe(false);
    });

    it("throws when healing and killing the same player", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.WITCH, Role.VILLAGER]);
      game.players[0].nightAction = { targetUUID: "p2" }; // werewolf victim
      expect(() => WitchHandler.handlePotion(game, game.players[1], true, "p2")).toThrow("cannot heal and kill the same player");
      expect(game.players[1].usedHealingPotion).toBe(false);
      expect(game.players[1].usedKillingPotion).toBe(false);
      expect(game.players[1].nightAction).toBeNull();
    });

    it("rejects killing the healed victim in a separate call", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.WITCH, Role.VILLAGER]);
      game.players[0].nightAction = { targetUUID: "p2" }; // werewolf victim
      WitchHandler.handlePotion(game, game.players[1], true, null); // HEAL call
      expect(() => WitchHandler.handlePotion(game, game.players[1], null, "p2")).toThrow("cannot heal and kill the same player");
      expect(game.players[1].usedKillingPotion).toBe(false);
      expect(game.players[1].nightAction).toEqual({ heal: true });
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

    it("throws when the target is missing", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.RED_LADY, Role.VILLAGER]);
      expect(() => RedLadyHandler.handleSleepover(game, game.players[0], undefined as any)).toThrow("did not choose a player");
      expect(game.players[0].nightAction).toBeNull();
    });

    it("throws when the target is dead", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.RED_LADY, Role.VILLAGER]);
      game.players[1].isAlive = false;
      expect(() => RedLadyHandler.handleSleepover(game, game.players[0], "p1")).toThrow("already dead");
      expect(game.players[0].nightAction).toBeNull();
    });

    it("throws when sleeping over at their own place", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.RED_LADY, Role.VILLAGER]);
      expect(() => RedLadyHandler.handleSleepover(game, game.players[0], "p0")).toThrow("cannot sleep over at their own place");
    });
  });
});
