import { GameStore } from "../store/game.store.js";
import { type Game, type Player } from "../models.js";
import { Role, } from '@shared/roles.js';
import { Phase } from "@shared/phases.js";
import type { Snapshot } from '@shared/snapshot.js';
import { NightHandler } from "./handlers/night.handler.js";
import { VoteHandler } from "./handlers/vote.handler.js";
import { socketService } from "../socket.service.js";
import { getLocalPlayerState } from "./communication/sync.provider.js";
import { checkPlayerNightRole } from "./selectors/night.selectors.js";
import { LobbyHander } from "./handlers/lobby.handler.js";
import { SeatRegistry, type Seat } from "./seat.registry.js";
import { journal } from "../debug/journal.js";
import { logEvent, serializeError } from "../debug/log.js";

export class GameManager {
    private store = GameStore.getInstance();
    private readonly seats: SeatRegistry;

    constructor(seats: SeatRegistry = new SeatRegistry()) {
        this.seats = seats;
    }

    private getGameById(gameId: string): Game {
        const game = this.store.getGame(gameId);
        if(!game) throw new Error(`Game with ID ${gameId} not found`);
        return game;
    }

    /** Whether a game exists at all. Used to avoid journaling fuzzed/unknown ids. */
    knowsGame(gameId: string): boolean {
        return this.store.hasGame(gameId);
    }

    /** Which seat a socket currently holds, for the debug record. */
    describeSocket(socketId: string): Seat | null {
        return this.seats.seatOf(socketId) ?? null;
    }

    private getPlayerBySocketId(game: Game, socketId: string): Player {
        // The registry is authoritative and can point at a seat whose "primary" socketId
        // is a different (newer) socket.
        const seat = this.seats.seatOf(socketId);
        if(seat && seat.gameId === game.gameId) {
            const bound = game.players.find((player) => player.playerUUID === seat.playerUUID);
            if(bound) return bound;
        }

        // Fallback for games seeded directly (unit tests), where the registry has no binding.
        const player = game.players.find((player) => player.socketId === socketId);
        if(!player) throw new Error(`Player with socketId ${socketId} not found in ${game.gameId}`);
        return player;
    }

    private assertManager(game: Game, socketId: string): void {
        const player = this.getPlayerBySocketId(game, socketId);
        if(!game.managerUUID || player.playerUUID !== game.managerUUID) {
            throw new Error(`Only the game manager can do that in game ${game.gameId}`);
        }
    }

    // The registry knows which sockets still hold the seat; the game owns the player.
    // Only the socket that is the player's primary may promote the next one: an older
    // tab disconnecting must not steal the seat from a newer one.
    private repairPrimarySocket(game: Game, seat: Seat, socketId: string, nextPrimary: string | null): void {
        const player = game.players.find((p) => p.playerUUID === seat.playerUUID);
        if(player && player.socketId === socketId) player.socketId = nextPrimary;
    }

    private broadcastStateAndStore(game: Game) {
        // The store holds the Game by reference, so persisting first is about isolating
        // a throwing selector: one bad snapshot must not desync everyone after it.
        this.store.updateGame(game);
        // One journal entry per state version, with the full table frozen at this moment.
        // It runs before the per-player snapshots on purpose: if a selector throws below,
        // the state that caused it is already recorded.
        journal.recordState(game);
        game.players.forEach((player) => {
            const playerUUID = player.playerUUID;
            if(!playerUUID) return;

            const sockets = this.seats.socketsFor({ gameId: game.gameId, playerUUID });
            // A seat seeded without going through joinGame still has a socket on the player.
            if(player.socketId && !sockets.includes(player.socketId)) sockets.push(player.socketId);
            if(sockets.length === 0) return;
            // getLocalPlayerState treats a seat without a socket as a broken invariant.
            if(!player.socketId) player.socketId = sockets[sockets.length - 1]!;

            let snapshot: Snapshot;
            try {
                snapshot = getLocalPlayerState(game, player);
            } catch (error: any) {
                const serialized = serializeError(error);
                logEvent("error", "snapshot.failed", { game: game.gameId, player: playerUUID, ...serialized });
                journal.getOrCreate(game.gameId).note("snapshot.failed", null, { player: playerUUID, error: serialized.message });
                return;
            }

            sockets.forEach((socketId) => {
                try {
                    socketService.syncState(socketId, snapshot);
                } catch (error: any) {
                    const serialized = serializeError(error);
                    logEvent("error", "snapshot.sync_failed", { game: game.gameId, player: playerUUID, socket: socketId, ...serialized });
                    journal.getOrCreate(game.gameId).note("snapshot.sync_failed", null, { player: playerUUID, socket: socketId, error: serialized.message });
                }
            });
        });
    }

    handleDisconnect(socketId: string): void {
        // Release first: it names the seat this socket held and the socket that should
        // become primary (another live socket, or null when this was the last one).
        const released = this.seats.release(socketId);
        // A connected socket that never joined (or only created the game) has no seat.
        if(!released) return;

        const game = this.store.getGame(released.seat.gameId);
        if(!game) return;

        this.repairPrimarySocket(game, released.seat, socketId, released.nextPrimary);

        // Naming how many sockets still hold the seat is what makes a reconnect bug
        // readable: "online elsewhere" and "entirely offline" look identical in the state.
        const remaining = released.remaining.length;
        const label = remaining > 0 ? `disconnect (${remaining} still bound)` : 'disconnect (seat offline)';
        journal.recordSocket(released.seat.gameId, label, socketId, released.seat.playerUUID);
        this.broadcastStateAndStore(game);
    }

    // TODO: outsource to other file
    private checkGameOver(game: Game) {
        // TODO: make end of game logic more elaborate (e.g. if 3 werewolves + 1 villager => village cannot win)
        const alivePlayers = game.players.filter((player) => player.isAlive);
        if(alivePlayers.length === 0) { // no more players alive
            game.phase = Phase.GAME_OVER;
            game.winningTeam = null;
            return;
        }
        // OPTION 1: only werewolves are alive
        const isWerewolf = (player: Player) => player.role == Role.WEREWOLF;
        if(alivePlayers.every(isWerewolf)) {
            game.phase = Phase.GAME_OVER;
            game.winningTeam = 'werewolves'; // only werewolves alive
        }
        // OPTION 2: all werewolves are dead
        if(!alivePlayers.some(isWerewolf)) {
            game.phase = Phase.GAME_OVER;
            game.winningTeam = 'village'; // all werewolves are dead
        }
        // OPTION 3: only the loving pair is alive
        if(alivePlayers.length === 2) {
            const a = alivePlayers[0];
            const b = alivePlayers[1];
            if (a && b && a.lovePartner === b.playerUUID && b.lovePartner === a.playerUUID) {
                game.phase = Phase.GAME_OVER;
                game.winningTeam = 'couple'; // only couple lives
            }
        }
    }

    createGame(socketId: string): void {
        this.store.cleanupOldGames(); // clean up inactive games (default 24h)
        journal.prune();
        const newGame = LobbyHander.createGame();
        socketService.notifyGameCreated(socketId, newGame.gameId);
        this.store.createGame(newGame);
        journal.noteGameCreated(newGame);
        socketService.joinRoom(socketId, newGame.gameId);
    }

    joinGame(socketId: string, gameId: string, playerUUID: string | null): void {
        const game = this.getGameById(gameId);

        // A socket that already holds a seat in this game is rejoining, not joining twice.
        // Emitting joinGame twice used to create a second seat on the same socket: two
        // players shared one socketId, one of them consumed a role and could never act,
        // and the client received alternating snapshots.
        const boundSeat = this.seats.seatOf(socketId);
        if(boundSeat && boundSeat.gameId === game.gameId) {
            playerUUID = boundSeat.playerUUID;
        } else {
            const seatOfThisSocket = game.players.find((p) => p.socketId === socketId);
            if(seatOfThisSocket) playerUUID = seatOfThisSocket.playerUUID;
        }

        const existingPlayer = playerUUID ? game.players.find((p) => p.playerUUID === playerUUID) : undefined;

        if(existingPlayer && playerUUID) {
            // REJOIN (e.g. after refreshing the page) in any phase. The seat is bound to this
            // socket in addition to any socket that still holds it, so neither phone goes dark.
            LobbyHander.connectPlayerToSocket(game, playerUUID, socketId);
        } else if(game.phase === Phase.LOBBY) {
            // JOIN game (in Lobby Phase)
            playerUUID = LobbyHander.createNewPlayer(game, socketId);
            socketService.notifyPlayerJoined(socketId, {
                gameId: gameId,
                playerUUID: playerUUID,
            })
        } else {
            // A new player can only enter while the lobby is open. Say so instead of
            // letting connectPlayerToSocket throw "Player with UUID null not found".
            throw new Error(`Game ${gameId} is no longer accepting new players`);
        }

        // A socket holds one seat at a time. If it was playing another game, binding it
        // here releases that seat; repair the old game's primary before moving on.
        const released = this.seats.bind({ gameId: game.gameId, playerUUID }, socketId);
        if(released) {
            const previousGame = this.store.getGame(released.seat.gameId);
            if(previousGame) {
                this.repairPrimarySocket(previousGame, released.seat, socketId, released.nextPrimary);
            }
        }
        socketService.joinRoom(socketId, game.gameId);
        journal.recordSocket(game.gameId, 'join', socketId, playerUUID);
        this.broadcastStateAndStore(game);
    }

    changeName(gameId: string, socketId: string, newName: string): void {
        const game = this.getGameById(gameId);
        const player = this.getPlayerBySocketId(game, socketId);
        LobbyHander.changeName(game, player, newName);
        this.broadcastStateAndStore(game);
    }

    closeJoining(gameId: string, socketId: string): void {
        const game = this.getGameById(gameId);
        this.assertManager(game, socketId);
        LobbyHander.closeJoining(game);
        this.broadcastStateAndStore(game);
    }

    roleDistribution(gameId: string, socketId: string, roles: Record<Role, number>): void {
        const game = this.getGameById(gameId);
        this.assertManager(game, socketId);
        LobbyHander.roleDistribution(game, roles);
        this.broadcastStateAndStore(game);
    }

    startGame(gameId: string, socketId: string): void {
        const game = this.getGameById(gameId);
        this.assertManager(game, socketId);
        LobbyHander.startGame(game);
        this.checkGameOver(game);
        this.broadcastStateAndStore(game);
    }

    nightAction<T extends any[]> (gameId: string, socketId: string, role: Role | null,
        handler: (game: Game, player: Player, ...args: T) => boolean,
        ...handlerArgs: T
    ): void {
        const game = this.getGameById(gameId);
        const player = this.getPlayerBySocketId(game, socketId);
        if(!player.isAlive) return;
        checkPlayerNightRole(game, player, role);

        const nextRole: boolean = handler(game, player, ...handlerArgs);
        if(nextRole) NightHandler.nextRole(game);
        this.checkGameOver(game);
        this.broadcastStateAndStore(game);
    }
    
    // both for sheriff election and lynch voting
    vote(gameId: string, socketId: string, targetUUID: string | false): void {
        const game = this.getGameById(gameId);
        const player = this.getPlayerBySocketId(game, socketId);
        if(!player.isAlive) return;
        if(game.phase === Phase.DAY) VoteHandler.castLynchVote(game, player, targetUUID);
        else if(game.phase === Phase.SHERIFF_ELECTION) VoteHandler.castSheriffVote(game, player, targetUUID);
        else throw new Error("Voting is closed right now.");
        this.checkGameOver(game);
        this.broadcastStateAndStore(game);
    }

    nominate(gameId: any, socketId: string, nominationUUID: any): void | Promise<void> {
        const game = this.getGameById(gameId);
        const player = this.getPlayerBySocketId(game, socketId);
        if(!player.isAlive) return;
        if(game.phase === Phase.DAY) VoteHandler.nominate(game, player, nominationUUID);
        else throw new Error("Nominations are closed.");
        this.checkGameOver(game);
        this.broadcastStateAndStore(game);
    }

    acceptSheriffRole(gameId: string, socketId: string) {
        const game = this.getGameById(gameId);
        const player = this.getPlayerBySocketId(game, socketId);
        // A dead player cannot act, but the game manager must be able to end the election
        // even when they are dead, otherwise a dead GM freezes the game in SHERIFF_ELECTION
        if(!player.isAlive && player.playerUUID !== game.managerUUID) return;
        VoteHandler.acceptSheriffRole(game, player);
        this.broadcastStateAndStore(game);
    }

    readyForNight(gameId: string, socketId: string) {
        const game = this.getGameById(gameId);
        const player = this.getPlayerBySocketId(game, socketId);
        if(!player.isAlive) return;
        VoteHandler.readyForNight(game, player);
        this.broadcastStateAndStore(game);
    }

    // The game manager's escape hatch: one step forward when a phase is stuck because
    // somebody went AFK. No timeout exists, so this is the only way out.
    managerAdvance(gameId: string, socketId: string) {
        const game = this.getGameById(gameId);
        const player = this.getPlayerBySocketId(game, socketId);
        if(!game.managerUUID || player.playerUUID !== game.managerUUID) {
            throw new Error(`Only the game manager can advance the game (${gameId})`);
        }

        if(game.phase === Phase.NIGHT) NightHandler.forceNextRole(game);
        else if(game.phase === Phase.DAY || game.phase === Phase.SHERIFF_ELECTION) VoteHandler.forceAdvance(game);
        else throw new Error(`Cannot advance game ${gameId} in phase ${game.phase}`);

        this.checkGameOver(game);
        this.broadcastStateAndStore(game);
    }
}