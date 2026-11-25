import type { Game } from "../models.js";

export class GameStore {
    private static instance: GameStore;
    private games: Map<string, Game> = new Map();

    static getInstance(): GameStore {
        if(!GameStore.instance) GameStore.instance = new GameStore();
        return this.instance;
    }

    // Refuses to overwrite an existing game: a duplicate id would silently replace a running game.
    createGame(game: Game): void {
        if (this.games.has(game.gameId)) throw new Error(`Game with ID ${game.gameId} already exists`);
        this.games.set(game.gameId, game);
    }

    hasGame(gameId: string): boolean {
        return this.games.has(gameId);
    }

    getGame(gameId: string): Game | undefined {
        return this.games.get(gameId);
    }

    updateGame(game: Game): void {
        this.games.set(game.gameId, game);
    }

    deleteGame(gameId: string): void {
        this.games.delete(gameId);
    }

    cleanupOldGames(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
        const now = Date.now();
        for (const [gameId, game] of this.games.entries()) {
            if (now - game.createdAt > maxAgeMs) {
                console.log(`Cleaning up old game: ${gameId}`);
                this.games.delete(gameId);
            }
        }
    }

    clear(): void {
        this.games.clear();
    }


}