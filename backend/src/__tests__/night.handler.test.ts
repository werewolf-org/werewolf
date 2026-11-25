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

    it("skips a victim that is already dead instead of killing their partner", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      game.round = 1;
      game.activeNightRole = Role.WEREWOLF;
      game.players[1].lovePartner = "p2";
      game.players[2].lovePartner = "p1";
      game.players[2].isAlive = false;
      game.players[0].nightAction = { targetUUID: "p2" };
      NightHandler.nextRole(game);
      expect(game.players[1].isAlive).toBe(true); // partner of a corpse survives
    });

    it("does not kill a player the witch heals and kills in the same night", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.WITCH, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      game.round = 1;
      game.activeNightRole = Role.WITCH;
      game.players[0].nightAction = { targetUUID: "p2" };
      game.players[1].nightAction = { heal: true, killUUID: "p2" };
      NightHandler.nextRole(game);
      expect(game.phase).toBe(Phase.DAY);
      expect(game.players[2].isAlive).toBe(true);
    });

    it("does not throw when a red lady night action has no target", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.RED_LADY, Role.WEREWOLF, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      game.round = 1;
      game.activeNightRole = Role.RED_LADY;
      game.players[0].nightAction = {};
      game.players[1].nightAction = { targetUUID: "p2" };
      expect(() => NightHandler.nextRole(game)).not.toThrow(); // -> WEREWOLF
      expect(() => NightHandler.nextRole(game)).not.toThrow(); // -> end of night
      expect(game.phase).toBe(Phase.DAY);
    });
  });

  describe("sheriff badge on night deaths", () => {
    it("clears the badge when the sheriff is killed at night", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      game.round = 1;
      game.activeNightRole = Role.WEREWOLF;
      game.sheriffUUID = "p1";
      game.players[0].nightAction = { targetUUID: "p1" };
      NightHandler.nextRole(game);
      expect(game.players[1].isAlive).toBe(false);
      expect(game.sheriffUUID).toBeNull();
    });

    it("clears the badge when the sheriff dies as a love partner", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      game.round = 1;
      game.activeNightRole = Role.WEREWOLF;
      game.sheriffUUID = "p2";
      game.players[1].lovePartner = "p2";
      game.players[2].lovePartner = "p1";
      game.players[0].nightAction = { targetUUID: "p1" };
      NightHandler.nextRole(game);
      expect(game.players[2].isAlive).toBe(false);
      expect(game.sheriffUUID).toBeNull();
    });

    it("keeps the badge when the sheriff survives the night", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      game.round = 1;
      game.activeNightRole = Role.WEREWOLF;
      game.sheriffUUID = "p2";
      game.players[0].nightAction = { targetUUID: "p1" };
      NightHandler.nextRole(game);
      expect(game.players[2].isAlive).toBe(true);
      expect(game.sheriffUUID).toBe("p2");
    });
  });

  describe("forceNextRole", () => {
    it("is a no-op when there is no active night role", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      game.activeNightRole = null;
      NightHandler.forceNextRole(game);
      expect(game.phase).toBe(Phase.NIGHT);
      expect(game.activeNightRole).toBeNull();
    });

    it("is a no-op outside the NIGHT phase", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER]);
      game.phase = Phase.DAY;
      game.activeNightRole = Role.WEREWOLF;
      NightHandler.forceNextRole(game);
      expect(game.phase).toBe(Phase.DAY);
      expect(game.activeNightRole).toBe(Role.WEREWOLF);
    });

    it("walks forward by one role and resolves the night from the last role", () => {
      const game = createGameWithPlayers(5);
      setRoles(game, [Role.CUPID, Role.RED_LADY, Role.WEREWOLF, Role.SEER, Role.WITCH]);
      game.phase = Phase.NIGHT;
      game.round = 0;
      game.sheriffElectionDone = true; // so night end resolves to DAY
      const order = [Role.CUPID, Role.RED_LADY, Role.WEREWOLF, Role.SEER, Role.WITCH];

      for (let i = 0; i < order.length - 1; i++) {
        game.activeNightRole = order[i]!;
        NightHandler.forceNextRole(game);
        expect(game.activeNightRole).toBe(order[i + 1]);
      }

      game.activeNightRole = Role.WITCH;
      NightHandler.forceNextRole(game);
      expect(game.activeNightRole).toBeNull();
      expect(game.phase).toBe(Phase.DAY);
    });

    it("continues after the active role when its only player died", () => {
      const game = createGameWithPlayers(4);
      setRoles(game, [Role.CUPID, Role.WEREWOLF, Role.SEER, Role.WITCH]);
      game.phase = Phase.NIGHT;
      game.round = 0;
      game.players[2].isAlive = false; // seer is dead, SEER is not part of the night
      game.activeNightRole = Role.SEER;
      NightHandler.forceNextRole(game);
      expect(game.activeNightRole).toBe(Role.WITCH);
    });
  });
});
