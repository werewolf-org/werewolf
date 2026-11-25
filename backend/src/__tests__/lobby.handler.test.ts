import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockGame, createMockPlayer, createGameWithPlayers } from "./test-helpers.js";
import { Phase } from "@shared/phases.js";
import { Role } from "@shared/roles.js";
import { LobbyHander, MIN_PLAYERS } from "../logic/handlers/lobby.handler.js";
import { GameStore } from "../store/game.store.js";

describe("lobby.handler", () => {
  beforeEach(() => {
    GameStore.getInstance().clear();
  });

  describe("createGame", () => {
    it("creates a game with a 4-char uppercase ID", () => {
      const game = LobbyHander.createGame();
      expect(game.gameId).toMatch(/^[A-Z0-9]{4}$/);
    });

    it("always produces IDs of the expected length", () => {
      for (let i = 0; i < 200; i++) {
        expect(LobbyHander.createGame().gameId).toHaveLength(4);
      }
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

    it("skips game IDs that already exist in the store", () => {
      const store = GameStore.getInstance();
      // every Math.random() call below returns 0 -> "AAAA", then 0.5 -> "SSSS"
      const randomSpy = vi.spyOn(Math, "random");
      for (let i = 0; i < 4; i++) randomSpy.mockReturnValueOnce(0);
      for (let i = 0; i < 4; i++) randomSpy.mockReturnValueOnce(0.5);
      store.createGame(createMockGame({ gameId: "AAAA" }));

      const game = LobbyHander.createGame();
      randomSpy.mockRestore();

      expect(game.gameId).not.toBe("AAAA");
      expect(game.gameId).toBe("SSSS");
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
      for (let i = 0; i < MIN_PLAYERS; i++) game.players.push(createMockPlayer({ displayName: `Alice ${i}` }));
      LobbyHander.closeJoining(game);
      expect(game.phase).toBe(Phase.ROLE_SELECTION);
    });

    it("auto-names unnamed players sequentially", () => {
      const game = LobbyHander.createGame();
      game.players.push(createMockPlayer({ displayName: "Alice" }));
      for (let i = 0; i < MIN_PLAYERS - 1; i++) game.players.push(createMockPlayer({ displayName: "" }));
      LobbyHander.closeJoining(game);
      expect(game.players[0].displayName).toBe("Alice");
      for (let i = 1; i < MIN_PLAYERS; i++) {
        expect(game.players[i].displayName).toBe(`Unnamed Player ${i}`);
      }
    });

    it("rejects a game below the minimum player count", () => {
      const game = LobbyHander.createGame();
      for (let i = 0; i < MIN_PLAYERS - 1; i++) game.players.push(createMockPlayer());
      expect(() => LobbyHander.closeJoining(game)).toThrow(`at least ${MIN_PLAYERS} are required`);
      expect(game.phase).toBe(Phase.LOBBY);
    });

    it("rejects a game with no players at all", () => {
      const game = LobbyHander.createGame();
      expect(() => LobbyHander.closeJoining(game)).toThrow(`at least ${MIN_PLAYERS} are required`);
      expect(game.phase).toBe(Phase.LOBBY);
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

    it("rejects a distribution without any werewolf", () => {
      const game = createGameWithPlayers(4);
      game.phase = Phase.ROLE_SELECTION;
      expect(() => LobbyHander.roleDistribution(game, { [Role.VILLAGER]: 3, [Role.SEER]: 1 }))
        .toThrow("at least one Werewolf");
      expect(game.players.every((p) => p.role === null)).toBe(true);
      expect(game.phase).toBe(Phase.ROLE_SELECTION);
    });

    it("rejects unknown role keys", () => {
      const game = createGameWithPlayers(4);
      game.phase = Phase.ROLE_SELECTION;
      expect(() => LobbyHander.roleDistribution(game, { FOO: 4 } as any)).toThrow("Unknown role FOO");
      expect(game.players.every((p) => p.role === null)).toBe(true);
      expect(game.phase).toBe(Phase.ROLE_SELECTION);
    });

    it("rejects negative or fractional counts", () => {
      const game = createGameWithPlayers(4);
      game.phase = Phase.ROLE_SELECTION;
      expect(() => LobbyHander.roleDistribution(game, { [Role.WEREWOLF]: -1, [Role.VILLAGER]: 5 }))
        .toThrow("Invalid amount -1");
      expect(() => LobbyHander.roleDistribution(game, { [Role.WEREWOLF]: 1.5, [Role.VILLAGER]: 2.5 }))
        .toThrow("Invalid amount 1.5");
      expect(game.players.every((p) => p.role === null)).toBe(true);
      expect(game.phase).toBe(Phase.ROLE_SELECTION);
    });

    it("rejects a wrong total and leaves every player untouched", () => {
      const game = createGameWithPlayers(4);
      game.phase = Phase.ROLE_SELECTION;
      expect(() => LobbyHander.roleDistribution(game, { [Role.WEREWOLF]: 1, [Role.VILLAGER]: 2 }))
        .toThrow("does not match number of players");
      expect(game.players.every((p) => p.role === null)).toBe(true);
      expect(game.phase).toBe(Phase.ROLE_SELECTION);
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

    it("leaves the game in DISTRIBUTION when no role wakes up", () => {
      const game = createGameWithPlayers(2);
      game.players[0].role = Role.VILLAGER;
      game.players[1].role = Role.LITTLE_GIRL;
      game.phase = Phase.DISTRIBUTION;
      expect(() => LobbyHander.startGame(game)).toThrow("does not have an active night role");
      expect(game.phase).toBe(Phase.DISTRIBUTION);
      expect(game.activeNightRole).toBeNull();
      expect(game.players[0].role).toBe(Role.VILLAGER);
    });
  });
});
