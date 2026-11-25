import { describe, it, expect, beforeEach } from 'vitest';
import { GameManager } from '../logic/game.manager.js';
import { GameStore } from '../store/game.store.js';
import { socketService } from '../socket.service.js';
import { createGameWithPlayers, setRoles } from './test-helpers.js';
import { Role } from '@shared/roles.js';
import { Phase } from '@shared/phases.js';
import { WerewolfHandler } from '../logic/handlers/role.handler.js';
import type { Game } from '../models.js';

// The manager emits through the SocketService singleton. Stub it so tests do not need a
// real Socket.IO server (and so log noise does not hide real errors).
const fakeIo = {
    sockets: { sockets: new Map() },
    to: () => ({ emit: () => undefined }),
};
socketService.init(fakeIo as any);

const store = GameStore.getInstance();

const seed = (game: Game): Game => {
    store.createGame(game);
    return game;
};

describe('GameManager: identity & authorization', () => {
    let manager: GameManager;

    beforeEach(() => {
        store.clear();
        manager = new GameManager();
    });

    it('rejects manager-only lobby actions from a non-manager player', () => {
        const game = seed(createGameWithPlayers(5, { managerUUID: 'p0' }));

        expect(() => manager.closeJoining(game.gameId, 's1')).toThrow(/game manager/);
        expect(() => manager.roleDistribution(game.gameId, 's1', { [Role.WEREWOLF]: 1, [Role.VILLAGER]: 4 } as any))
            .toThrow(/game manager/);
        expect(() => manager.startGame(game.gameId, 's1')).toThrow(/game manager/);

        expect(game.phase).toBe(Phase.LOBBY);
        expect(game.players.every((p) => p.role === null)).toBe(true);
    });

    it('rejects manager-only actions from a socket that is not in the game at all', () => {
        const game = seed(createGameWithPlayers(5, { managerUUID: 'p0' }));
        expect(() => manager.closeJoining(game.gameId, 'intruder')).toThrow(/not found/);
    });

    it('lets the actual manager close the lobby', () => {
        const game = seed(createGameWithPlayers(5, { managerUUID: 'p0' }));
        manager.closeJoining(game.gameId, 's0');
        expect(game.phase).toBe(Phase.ROLE_SELECTION);
    });
});

describe('GameManager: join & rejoin', () => {
    let manager: GameManager;

    beforeEach(() => {
        store.clear();
        manager = new GameManager();
    });

    it('rejoins an existing player in the lobby instead of adding a duplicate', () => {
        const game = seed(createGameWithPlayers(5, { managerUUID: 'p0' }));
        const playerCount = game.players.length;

        manager.joinGame('new-socket', game.gameId, 'p1');

        expect(game.players.length).toBe(playerCount);
        expect(game.players.find((p) => p.playerUUID === 'p1')?.socketId).toBe('new-socket');
    });

    it('adds a new player while the lobby is open', () => {
        const game = seed(createGameWithPlayers(5, { managerUUID: 'p0' }));
        const playerCount = game.players.length;

        manager.joinGame('fresh-socket', game.gameId, null);

        expect(game.players.length).toBe(playerCount + 1);
    });

    it('rejoins an existing player after the lobby closed', () => {
        const game = seed(createGameWithPlayers(5, { managerUUID: 'p0', phase: Phase.DAY }));
        manager.joinGame('new-socket', game.gameId, 'p1');
        expect(game.players.find((p) => p.playerUUID === 'p1')?.socketId).toBe('new-socket');
    });

    it('refuses a new player once the lobby is closed, with a readable reason', () => {
        const game = seed(createGameWithPlayers(5, { managerUUID: 'p0', phase: Phase.DAY }));
        const playerCount = game.players.length;

        expect(() => manager.joinGame('fresh-socket', game.gameId, null)).toThrow(/no longer accepting/);
        expect(() => manager.joinGame('fresh-socket', game.gameId, 'ghost-uuid')).toThrow(/no longer accepting/);
        expect(game.players.length).toBe(playerCount);
    });
});

describe('GameManager: disconnect', () => {
    let manager: GameManager;

    beforeEach(() => {
        store.clear();
        manager = new GameManager();
    });

    it('clears the socket mapping of the disconnected player and keeps the seat', () => {
        const game = seed(createGameWithPlayers(5, { managerUUID: 'p0' }));
        manager.joinGame('s1', game.gameId, 'p1');

        manager.handleDisconnect('s1');

        const player = game.players.find((p) => p.playerUUID === 'p1');
        expect(player?.socketId).toBe(null);
        expect(game.players.length).toBe(5);
    });

    it('is a no-op for an unknown socket', () => {
        seed(createGameWithPlayers(5, { managerUUID: 'p0' }));
        expect(() => manager.handleDisconnect('never-seen')).not.toThrow();
    });

    it('does not clear a seat that has already been reclaimed by a newer socket', () => {
        const game = seed(createGameWithPlayers(5, { managerUUID: 'p0' }));
        manager.joinGame('old-socket', game.gameId, 'p1');
        manager.joinGame('new-socket', game.gameId, 'p1');

        manager.handleDisconnect('old-socket');

        expect(game.players.find((p) => p.playerUUID === 'p1')?.socketId).toBe('new-socket');
    });
});

describe('GameManager: manager escape hatch', () => {
    let manager: GameManager;

    beforeEach(() => {
        store.clear();
        manager = new GameManager();
    });

    it('rejects force-advance from a non-manager', () => {
        const game = seed(createGameWithPlayers(5, {
            managerUUID: 'p0',
            phase: Phase.NIGHT,
            activeNightRole: Role.SEER,
        }));
        expect(() => manager.managerAdvance(game.gameId, 's1')).toThrow(/game manager/);
        expect(game.activeNightRole).toBe(Role.SEER);
    });

    it('refuses to advance a phase that cannot be skipped', () => {
        const game = seed(createGameWithPlayers(5, { managerUUID: 'p0', phase: Phase.LOBBY }));
        expect(() => manager.managerAdvance(game.gameId, 's0')).toThrow(/Cannot advance/);
    });

    it('advances the night by exactly one role for the manager', () => {
        const game = seed(createGameWithPlayers(5, {
            managerUUID: 'p0',
            phase: Phase.NIGHT,
            activeNightRole: Role.SEER,
        }));
        setRoles(game, [Role.WEREWOLF, Role.WEREWOLF, Role.SEER, Role.WITCH, Role.VILLAGER]);

        manager.managerAdvance(game.gameId, 's0');

        expect(game.activeNightRole).not.toBe(Role.SEER);
    });

    it('moves the day forward when a player never votes', () => {
        const game = seed(createGameWithPlayers(5, {
            managerUUID: 'p0',
            phase: Phase.DAY,
        }));
        game.players.forEach((p) => {
            p.nominationUUID = false;
        });

        manager.managerAdvance(game.gameId, 's0');

        expect(game.nominationsFinished || game.lynchDone || game.phase !== Phase.DAY).toBe(true);
    });
});

describe('GameManager: dead players cannot act', () => {
    let manager: GameManager;

    beforeEach(() => {
        store.clear();
        manager = new GameManager();
    });

    it('ignores a night action from a dead player', () => {
        const game = seed(createGameWithPlayers(5, {
            managerUUID: 'p0',
            phase: Phase.NIGHT,
            activeNightRole: Role.WEREWOLF,
        }));
        setRoles(game, [Role.WEREWOLF, Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER, Role.VILLAGER]);
        game.players[0].isAlive = false;

        manager.nightAction(game.gameId, 's0', Role.WEREWOLF, WerewolfHandler.handleVote, 'p2');

        expect(game.players[0].nightAction).toBe(null);
    });

    it('allows a dead game manager to end the sheriff election', () => {
        const game = seed(createGameWithPlayers(5, {
            managerUUID: 'p0',
            phase: Phase.SHERIFF_ELECTION,
            sheriffElectionDone: true,
            sheriffUUID: 'p1',
        }));
        game.players[0].isAlive = false;

        manager.acceptSheriffRole(game.gameId, 's0');

        expect(game.phase).toBe(Phase.DAY);
    });

    it('ignores acceptSheriffRole from a dead non-manager', () => {
        const game = seed(createGameWithPlayers(5, {
            managerUUID: 'p0',
            phase: Phase.SHERIFF_ELECTION,
            sheriffElectionDone: true,
            sheriffUUID: 'p1',
        }));
        game.players[2].isAlive = false;

        manager.acceptSheriffRole(game.gameId, 's2');

        expect(game.phase).toBe(Phase.SHERIFF_ELECTION);
    });
});
