import { describe, it, expect, beforeEach } from 'vitest';
import { GameManager } from '../logic/game.manager.js';
import { GameStore } from '../store/game.store.js';
import { socketService } from '../socket.service.js';
import { createGameWithPlayers } from './test-helpers.js';
import type { Game } from '../models.js';

// One seat, several sockets. A phone can hold a seat through more than one socket (a
// second tab, a reopened link, or a reconnect that beats the old socket's timeout), and
// every one of those sockets is a screen the player may be looking at. They all get
// snapshots and any of them may act; closing one must never unbind the others.

interface Sent { socketId: string; event: string; data: any }

const sent: Sent[] = [];
const fakeIo = {
    sockets: { sockets: new Map() },
    to: (socketId: string) => ({
        emit: (event: string, data: any) => { sent.push({ socketId, event, data }); },
    }),
};
socketService.init(fakeIo as any);

const store = GameStore.getInstance();

const seed = (game: Game): Game => {
    store.createGame(game);
    return game;
};

describe('GameManager: several sockets on one seat', () => {
    let manager: GameManager;

    beforeEach(() => {
        store.clear();
        sent.length = 0;
        manager = new GameManager();
    });

    it('sends each snapshot to every socket bound to the seat', () => {
        const game = seed(createGameWithPlayers(5, { managerUUID: 'p0' }));
        // Bind the seeded socket, then a second tab for the same seat.
        manager.joinGame('s0', game.gameId, 'p0');
        manager.joinGame('tab-2', game.gameId, 'p0');

        sent.length = 0;
        manager.changeName(game.gameId, 'tab-2', 'Ben');

        const p0Snapshots = sent
            .filter((entry) => entry.event === 'syncState' && entry.data.playerUUID === 'p0')
            .map((entry) => entry.socketId);
        expect(new Set(p0Snapshots)).toEqual(new Set(['s0', 'tab-2']));
        // The action was made on the newer socket but both views show the new name.
        const p0Views = sent.filter((entry) => entry.event === 'syncState' && entry.data.playerUUID === 'p0');
        expect(p0Views.every((entry) => entry.data.displayName === 'Ben')).toBe(true);
    });

    it('accepts an action from the older socket after a newer one joined', () => {
        const game = seed(createGameWithPlayers(5, { managerUUID: 'p0' }));
        manager.joinGame('s0', game.gameId, 'p0');
        manager.joinGame('tab-2', game.gameId, 'p0');

        expect(() => manager.changeName(game.gameId, 's0', 'Older tab')).not.toThrow();
        expect(game.players.find((p) => p.playerUUID === 'p0')?.displayName).toBe('Older tab');

        expect(() => manager.changeName(game.gameId, 'tab-2', 'Newer tab')).not.toThrow();
        expect(game.players.find((p) => p.playerUUID === 'p0')?.displayName).toBe('Newer tab');
    });

    it('keeps the seat bound when one of the sockets disconnects', () => {
        const game = seed(createGameWithPlayers(5, { managerUUID: 'p0' }));
        manager.joinGame('s0', game.gameId, 'p0');
        manager.joinGame('tab-2', game.gameId, 'p0');

        manager.handleDisconnect('tab-2');

        const player = game.players.find((p) => p.playerUUID === 'p0')!;
        expect(player.socketId).toBe('s0');
        // The survivor is still a first-class player.
        expect(() => manager.changeName(game.gameId, 's0', 'Still here')).not.toThrow();
    });

    it('only clears the seat once the last socket is gone', () => {
        const game = seed(createGameWithPlayers(5, { managerUUID: 'p0' }));
        manager.joinGame('s0', game.gameId, 'p0');
        manager.joinGame('tab-2', game.gameId, 'p0');
        manager.joinGame('tab-3', game.gameId, 'p0');

        manager.handleDisconnect('tab-3');
        expect(game.players.find((p) => p.playerUUID === 'p0')?.socketId).not.toBeNull();

        manager.handleDisconnect('tab-2');
        expect(game.players.find((p) => p.playerUUID === 'p0')?.socketId).toBe('s0');

        manager.handleDisconnect('s0');
        expect(game.players.find((p) => p.playerUUID === 'p0')?.socketId).toBeNull();
    });

    it('gives every socket of the game master manager rights', () => {
        const game = seed(createGameWithPlayers(5, { managerUUID: 'p0' }));
        manager.joinGame('s0', game.gameId, 'p0');
        manager.joinGame('gm-tab-2', game.gameId, 'p0');

        expect(() => manager.closeJoining(game.gameId, 'gm-tab-2')).not.toThrow();
        expect(game.phase).toBe('ROLE_SELECTION');
    });

    it('does not treat a second socket as a second player', () => {
        const game = seed(createGameWithPlayers(5, { managerUUID: 'p0' }));
        const seatsBefore = game.players.map((p) => p.playerUUID);

        manager.joinGame('s0', game.gameId, 'p0');
        manager.joinGame('tab-2', game.gameId, 'p0');

        expect(game.players.map((p) => p.playerUUID)).toEqual(seatsBefore);
    });

    it('moves a socket out of the previous game when it joins another one', () => {
        const gameA = seed(createGameWithPlayers(3, { gameId: 'AAAA', managerUUID: 'p0' }));
        const gameB = seed(createGameWithPlayers(3, { gameId: 'BBBB', managerUUID: 'p0' }));
        const traveller = 'travelling-socket';

        manager.joinGame(traveller, gameA.gameId, 'p0');
        manager.joinGame(traveller, gameB.gameId, 'p0');

        // The same socket now plays B; it must not keep receiving A's tailored snapshots.
        sent.length = 0;
        manager.changeName(gameA.gameId, 's1', 'Still in A');

        const toTraveller = sent.filter((entry) => entry.socketId === traveller);
        expect(toTraveller).toHaveLength(0);

        // ...and it cannot act in the game it left.
        expect(() => manager.changeName(gameA.gameId, traveller, 'Ghost')).toThrow(/not found/);
        // ...while it is a first-class player in the new one.
        expect(() => manager.changeName(gameB.gameId, traveller, 'In B')).not.toThrow();
        expect(gameB.players.find((p) => p.playerUUID === 'p0')?.displayName).toBe('In B');
    });
});
