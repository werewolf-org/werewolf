import { describe, it, expect, beforeEach } from "vitest";
import { GameStore } from "../store/game.store.js";
import { createMockGame } from "./test-helpers.js";

describe("game.store", () => {
  beforeEach(() => {
    GameStore.getInstance().clear();
  });

  it("is a singleton", () => {
    const s1 = GameStore.getInstance();
    const s2 = GameStore.getInstance();
    expect(s1).toBe(s2);
  });

  it("creates and retrieves a game", () => {
    const store = GameStore.getInstance();
    const game = createMockGame();
    store.createGame(game);
    expect(store.getGame(game.gameId)).toBe(game);
  });

  it("returns undefined for nonexistent game", () => {
    const store = GameStore.getInstance();
    expect(store.getGame("FAKE")).toBeUndefined();
  });

  it("updates a game", () => {
    const store = GameStore.getInstance();
    const game = createMockGame();
    store.createGame(game);
    game.round = 5;
    store.updateGame(game);
    expect(store.getGame(game.gameId)!.round).toBe(5);
  });

  it("deletes a game", () => {
    const store = GameStore.getInstance();
    const game = createMockGame();
    store.createGame(game);
    store.deleteGame(game.gameId);
    expect(store.getGame(game.gameId)).toBeUndefined();
  });

  it("clears all games", () => {
    const store = GameStore.getInstance();
    store.createGame(createMockGame());
    store.createGame(createMockGame());
    store.clear();
    // getGame won't find anything since gameID is random
    const keys = Array.from((store as any).games.keys());
    expect(keys).toHaveLength(0);
  });

  it("cleanupOldGames removes only old games", () => {
    const store = GameStore.getInstance();
    const oldGame = createMockGame({ createdAt: Date.now() - 2000 });
    const newGame = createMockGame({ createdAt: Date.now() });
    // Override gameIds since createMockGame doesn't guarantee uniqueness
    oldGame.gameId = "OLDG";
    newGame.gameId = "NEWG";
    store.createGame(oldGame);
    store.createGame(newGame);
    store.cleanupOldGames(1000);
    expect(store.getGame("OLDG")).toBeUndefined();
    expect(store.getGame("NEWG")).toBe(newGame);
  });

  it("cleanupOldGames with default threshold keeps fresh games", () => {
    const store = GameStore.getInstance();
    const game = createMockGame({ createdAt: Date.now() });
    game.gameId = "FRES";
    store.createGame(game);
    store.cleanupOldGames();
    expect(store.getGame("FRES")).toBe(game);
  });
});
