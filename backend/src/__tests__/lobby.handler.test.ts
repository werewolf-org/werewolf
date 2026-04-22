import { describe, it, expect, vi } from "vitest";
import { createMockGame, createMockPlayer, createGameWithPlayers } from "./test-helpers.js";
import { Phase } from "@shared/phases.js";
import { Role } from "@shared/roles.js";
import { LobbyHander } from "../logic/handlers/lobby.handler.js";

describe("lobby.handler", () => {
  describe("createGame", () => {
    it("creates a game with a 4-char uppercase ID", () => {
      const game = LobbyHander.createGame();
      expect(game.gameId).toMatch(/^[A-Z0-9]{4}$/);
    });

    it("initializes all default fields", () => {
      const game = LobbyHander.createGame();
      expect(game.managerUUID).toBeNull();
      expect(game.players).toEqual([]);
      expect(game.round).toBe(0);
      expect(game.phase).toBe(Phase.LOBBY);
      expect(game.activeNightRole).toBeNull();
      expect(game.lynchDone).toBe(false);
      expect(game.sheriffElectionDone).toBe(false);
      expect(game.sheriffUUID).toBeNull();
      expect(game.lastVotedOutUUID).toBeNull();
      expect(game.createdAt).toBeLessThanOrEqual(Date.now());
    });

    it("generates unique game IDs across multiple calls", () => {
      const ids = new Set();
      for (let i = 0; i < 20; i++) {
        ids.add(LobbyHander.createGame().gameId);
      }
      expect(ids.size).toBe(20);
    });
  });

  describe("createNewPlayer", () => {
    it("makes first player the manager", () => {
      const game = LobbyHander.createGame();
      const id = LobbyHander.createNewPlayer(game, "socket-1");
      expect(game.managerUUID).toBe(id);
      expect(game.players).toHaveLength(1);
    });

    it("does not make second player the manager", () => {
      const game = LobbyHander.createGame();
      LobbyHander.createNewPlayer(game, "socket-1");
      const id2 = LobbyHander.createNewPlayer(game, "socket-2");
      expect(game.managerUUID).not.toBe(id2);
      expect(game.players).toHaveLength(2);
    });

    it("returns a valid UUIDv4", () => {
      const game = LobbyHander.createGame();
      const id = LobbyHander.createNewPlayer(game, "socket-1");
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("initializes player with all default fields", () => {
      const game = LobbyHander.createGame();
      const id = LobbyHander.createNewPlayer(game, "socket-1");
      const player = game.players[0];
      expect(player.playerUUID).toBe(id);
      expect(player.socketId).toBe("socket-1");
      expect(player.displayName).toBe("");
      expect(player.role).toBeNull();
      expect(player.isAlive).toBe(true);
      expect(player.lovePartner).toBeNull();
      expect(player.lovePartnerConfirmed).toBe(false);
      expect(player.usedHealingPotion).toBe(false);
      expect(player.usedKillingPotion).toBe(false);
      expect(player.nominationUUID).toBeNull();
      expect(player.voteTargetUUID).toBeNull();
      expect(player.readyForNight).toBe(false);
    });
  });

  describe("connectPlayerToSocket", () => {
    it("updates socketId for existing player", () => {
      const game = LobbyHander.createGame();
      LobbyHander.createNewPlayer(game, "old-socket");
      const playerUUID = game.players[0].playerUUID;
      LobbyHander.connectPlayerToSocket(game, playerUUID!, "new-socket");
      expect(game.players[0].socketId).toBe("new-socket");
    });

    it("throws when playerUUID does not exist", () => {
      const game = LobbyHander.createGame();
      expect(() => LobbyHander.connectPlayerToSocket(game, "fake-id", "socket")).toThrow("not found in Game");
    });
  });

  describe("changeName", () => {
    it("changes name in LOBBY phase", () => {
      const game = LobbyHander.createGame();
      const player = createMockPlayer();
      game.players.push(player);
      LobbyHander.changeName(game, player, "Alice");
      expect(player.displayName).toBe("Alice");
    });

    it("throws when not in LOBBY phase", () => {
      const game = createMockGame({ phase: Phase.DAY });
      const player = createMockPlayer();
      game.players.push(player);
      expect(() => LobbyHander.changeName(game, player, "Alice")).toThrow("not in Phase LOBBY");
    });
  });

  describe("closeJoining", () => {
    it("transitions to ROLE_SELECTION", () => {
      const game = LobbyHander.createGame();
      game.players.push(createMockPlayer({ displayName: "Alice" }));
      LobbyHander.closeJoining(game);
      expect(game.phase).toBe(Phase.ROLE_SELECTION);
    });

    it("auto-names unnamed players sequentially", () => {
      const game = LobbyHander.createGame();
      game.players.push(createMockPlayer({ displayName: "Alice" }));
      game.players.push(createMockPlayer({ displayName: "" }));
      game.players.push(createMockPlayer({ displayName: "" }));
      LobbyHander.closeJoining(game);
      expect(game.players[0].displayName).toBe("Alice");
      expect(game.players[1].displayName).toBe("Unnamed Player 1");
      expect(game.players[2].displayName).toBe("Unnamed Player 2");
    });

    it("throws when already not in LOBBY", () => {
      const game = createMockGame({ phase: Phase.DAY });
      expect(() => LobbyHander.closeJoining(game)).toThrow("already in progress");
    });
  });

  describe("roleDistribution", () => {
    it("successfully distributes roles matching player count", () => {
      const game = createGameWithPlayers(3);
      game.phase = Phase.ROLE_SELECTION;
      LobbyHander.roleDistribution(game, { [Role.VILLAGER]: 1, [Role.WEREWOLF]: 2 });
      const roles = game.players.map((p) => p.role);
      expect(roles.filter((r) => r === Role.VILLAGER)).toHaveLength(1);
      expect(roles.filter((r) => r === Role.WEREWOLF)).toHaveLength(2);
      expect(game.phase).toBe(Phase.DISTRIBUTION);
    });

    it("throws when role count does not match player count", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.ROLE_SELECTION;
      expect(() => LobbyHander.roleDistribution(game, { [Role.VILLAGER]: 3 })).toThrow("does not match number of players");
    });

    it("throws when not in ROLE_SELECTION", () => {
      const game = createGameWithPlayers(2);
      game.phase = Phase.DAY;
      expect(() => LobbyHander.roleDistribution(game, { [Role.VILLAGER]: 2 })).toThrow("ROLE_SELECTION");
    });

    it("throws when no players defined", () => {
      const game = createMockGame({ phase: Phase.ROLE_SELECTION });
      game.players = undefined as any;
      expect(() => LobbyHander.roleDistribution(game, { [Role.VILLAGER]: 0 })).toThrow("No players are defined");
    });
  });

  describe("startGame", () => {
    it("transitions to NIGHT and sets activeNightRole", () => {
      const game = createGameWithPlayers(2);
      game.players[0].role = Role.WEREWOLF;
      game.players[1].role = Role.VILLAGER;
      game.phase = Phase.DISTRIBUTION;
      LobbyHander.startGame(game);
      expect(game.phase).toBe(Phase.NIGHT);
      expect(game.activeNightRole).not.toBeNull();
    });

    it("throws when not in DISTRIBUTION", () => {
      const game = createMockGame({ phase: Phase.LOBBY });
      expect(() => LobbyHander.startGame(game)).toThrow("not currently in the right phase");
    });

    it("throws when no active night role found", () => {
      const game = createGameWithPlayers(1);
      game.players[0].role = Role.VILLAGER;
      game.phase = Phase.DISTRIBUTION;
      expect(() => LobbyHander.startGame(game)).toThrow("does not have an active night role");
    });
  });
});
