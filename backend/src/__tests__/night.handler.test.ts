import { describe, it, expect } from "vitest";
import { createMockGame, createMockPlayer, createGameWithPlayers, setRoles } from "./test-helpers.js";
import { Phase } from "@shared/phases.js";
import { Role } from "@shared/roles.js";
import { NightHandler } from "../logic/handlers/night.handler.js";

describe("night.handler", () => {
  describe("nextRole", () => {
    it("advances to the next role in the night order", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.CUPID, Role.WEREWOLF, Role.SEER]);
      game.phase = Phase.NIGHT;
      game.round = 0;
      game.activeNightRole = Role.CUPID;
      NightHandler.nextRole(game);
      // Cupid(1) -> Werewolf(3) [RedLady(2) absent]
      expect(game.activeNightRole).toBe(Role.WEREWOLF);
    });

    it("calls startDay when no more roles", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      game.round = 1;
      game.activeNightRole = Role.WEREWOLF;
      NightHandler.nextRole(game);
      // Werewolf is last, so should go to DAY
      expect(game.activeNightRole).toBeNull();
      expect(game.phase).toBe(Phase.DAY);
    });

    it("transitions to SHERIFF_ELECTION on round 0", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      game.round = 0;
      game.activeNightRole = Role.WEREWOLF;
      NightHandler.nextRole(game);
      expect(game.phase).toBe(Phase.SHERIFF_ELECTION);
      expect(game.activeNightRole).toBeNull();
      expect(game.lynchDone).toBe(false);
    });

    it("resolves night actions when transitioning to day", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      game.round = 1;
      game.activeNightRole = Role.WEREWOLF;
      game.players[0].nightAction = { targetUUID: "p1" };
      NightHandler.nextRole(game);
      expect(game.players[1].isAlive).toBe(false);
      expect(game.players[0].nightAction).toBeNull();
    });

    it("does not kill when werewolf votes are split", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.WEREWOLF, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      game.round = 1;
      game.activeNightRole = Role.WEREWOLF;
      game.players[0].nightAction = { targetUUID: "p2" };
      game.players[1].nightAction = { targetUUID: "p0" };
      NightHandler.nextRole(game);
      // Round 1, Werewolf is last -> goes to DAY
      expect(game.phase).toBe(Phase.DAY);
      expect(game.players[2].isAlive).toBe(true); // nobody died
    });

    it("heals werewolf victim when witch heals", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.WITCH, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      game.round = 1;
      game.activeNightRole = Role.WITCH;
      game.players[0].nightAction = { targetUUID: "p2" };
      game.players[1].nightAction = { heal: true };
      game.players[1].usedHealingPotion = true;
      NightHandler.nextRole(game);
      expect(game.players[2].isAlive).toBe(true);
    });

    it("handles witch kill alongside werewolf kill", () => {
      const game = createGameWithPlayers(4);
      setRoles(game, [Role.WEREWOLF, Role.WITCH, Role.VILLAGER, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      game.round = 1;
      game.activeNightRole = Role.WITCH;
      game.players[0].nightAction = { targetUUID: "p2" };
      game.players[1].nightAction = { killUUID: "p3" };
      NightHandler.nextRole(game);
      expect(game.players[2].isAlive).toBe(false);
      expect(game.players[3].isAlive).toBe(false);
    });

    it("kills lover along with victim", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      game.round = 1;
      game.activeNightRole = Role.WEREWOLF;
      game.players[1].lovePartner = "p2";
      game.players[2].lovePartner = "p1";
      game.players[0].nightAction = { targetUUID: "p1" };
      NightHandler.nextRole(game);
      expect(game.players[1].isAlive).toBe(false);
      expect(game.players[2].isAlive).toBe(false);
    });
  });
});
