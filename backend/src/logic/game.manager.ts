import { GameStore } from "../store/game.store.js";
import { type Game, type Player } from "../models.js";
import { Role, } from '@shared/roles.js';
import { Phase } from "@shared/phases.js";
import { NightHandler } from "./handlers/night.handler.js";
import { VoteHandler } from "./handlers/vote.handler.js";
import { socketService } from "../socket.service.js";
import { getLocalPlayerState } from "./communication/sync.provider.js";
import { checkPlayerNightRole } from "./selectors/night.selectors.js";
import { LobbyHander } from "./handlers/lobby.handler.js";

export class GameManager {
    private store = GameStore.getInstance();
    // socket.id -> gameId, so a disconnect can be traced back to the seat it belonged to
    private socketGames = new Map<string, string>();
    // A seat can be held by more than one socket: a second tab, a reopened link, or a
    // reconnect that happens before the server has noticed the old socket died. All of
    // them are real phones showing real state, so all of them get snapshots and any of
    // them may act. Binding only the newest socket used to freeze every other tab until
    // the player manually refreshed the page.
    private socketSeats = new Map<string, { gameId: string; playerUUID: string }>();
    private seatSockets = new Map<string, Set<string>>();

    private seatKey(gameId: string, playerUUID: string): string {
        return `${gameId}:${playerUUID}`;
    }

    private bindSocketToSeat(gameId: string, playerUUID: string, socketId: string): void {
        // A socket holds one seat at a time. Without dropping the previous binding, a
        // socket that joins game B would stay in game A's fan-out set and keep receiving
        // A's tailored snapshots - including private ones - while it plays B.
        const previous = this.socketSeats.get(socketId);
        if(previous && (previous.gameId !== gameId || previous.playerUUID !== playerUUID)) {
            this.releaseSocketFromSeat(socketId);
        }

        const key = this.seatKey(gameId, playerUUID);
        let sockets = this.seatSockets.get(key);
        if(!sockets) {
            sockets = new Set();
            this.seatSockets.set(key, sockets);
        }
        sockets.add(socketId);
        this.socketSeats.set(socketId, { gameId, playerUUID });
    }

    private unbindSocket(socketId: string): { gameId: string; playerUUID: string } | undefined {
        const seat = this.socketSeats.get(socketId);
        this.socketSeats.delete(socketId);
        if(!seat) return undefined;

        const key = this.seatKey(seat.gameId, seat.playerUUID);
        const sockets = this.seatSockets.get(key);
        sockets?.delete(socketId);
        if(sockets && sockets.size === 0) this.seatSockets.delete(key);
        return seat;
    }

    // Remove a socket from its seat and repair the player's primary socketId: promote another
    // live socket of that seat, or clear it when this was the last one. Used both when a
    // socket disconnects and when it moves to a different game.
    private releaseSocketFromSeat(socketId: string): { seat: { gameId: string; playerUUID: string }; game: Game | undefined; player: Player | undefined } | undefined {
        const seat = this.unbindSocket(socketId);
        if(!seat) return undefined;

        const game = this.store.getGame(seat.gameId);
        const player = game?.players.find((p) => p.playerUUID === seat.playerUUID);
        if(player) {
            const remaining = this.socketsFor(seat.gameId, seat.playerUUID);
            if(remaining.length > 0) {
                if(player.socketId === socketId) player.socketId = remaining[remaining.length - 1]!;
            } else {
                player.socketId = null;
            }
        }
        return { seat, game, player };
    }

    private socketsFor(gameId: string, playerUUID: string): string[] {
        return [...(this.seatSockets.get(this.seatKey(gameId, playerUUID)) ?? [])];
    }

    private getGameById(gameId: string): Game {
        const game = this.store.getGame(gameId);
        if(!game) throw new Error(`Game with ID ${gameId} not found`);
        return game;
    }

    private getPlayerBySocketId(game: Game, socketId: string): Player {
        // The socket -> seat map is authoritative and can point at a seat whose "primary"
        // socketId is a different (newer) socket.
        const seat = this.socketSeats.get(socketId);
        if(seat && seat.gameId === game.gameId) {
            const bound = game.players.find((player) => player.playerUUID === seat.playerUUID);
            if(bound) return bound;
        }

        // Fallback for games seeded directly (unit tests) or a seat bound before this map.
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

    private broadcastStateAndStore(game: Game) {
        // The store holds the Game by reference, so persisting first is about isolating
        // a throwing selector: one bad snapshot must not desync everyone after it.
        this.store.updateGame(game);
        game.players.forEach((player) => {
            const playerUUID = player.playerUUID;
            if(!playerUUID) return;

            const sockets = this.socketsFor(game.gameId, playerUUID);
            // A seat seeded without going through joinGame still has a socket on the player.
            if(player.socketId && !sockets.includes(player.socketId)) sockets.push(player.socketId);
            if(sockets.length === 0) return;
            // getLocalPlayerState treats a seat without a socket as a broken invariant.
            if(!player.socketId) player.socketId = sockets[sockets.length - 1]!;

            let snapshot: object;
            try {
                snapshot = getLocalPlayerState(game, player);
            } catch (error: any) {
                console.error(`Failed to build state for ${playerUUID} in ${game.gameId}: ${error.message}`);
                return;
            }

            sockets.forEach((socketId) => {
                try {
                    socketService.syncState(socketId, snapshot);
                } catch (error: any) {
                    console.error(`Failed to sync state to ${socketId} (${playerUUID}) in ${game.gameId}: ${error.message}`);
                }
            });
        });
    }

    handleDisconnect(socketId: string): void {
        const gameId = this.socketGames.get(socketId);
        this.socketGames.delete(socketId);
        // Unbind first: it names the player this socket belonged to and repairs the seat's
        // primary socket (another live socket, or null when this was the last one).
        const released = this.releaseSocketFromSeat(socketId);

        const targetGameId = released?.seat.gameId ?? gameId;
        if(!targetGameId) return;

        const game = this.store.getGame(targetGameId);
        if(!game) return;

        // A connected socket that never joined (or only created the game) has no seat.
        if(!released) return;

        this.broadcastStateAndStore(game);
        const playerUUID = released.player?.playerUUID ?? released.seat.playerUUID;
        console.log(`Player ${playerUUID} disconnected from ${targetGameId}, seat kept for rejoin`);
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
        const newGame = LobbyHander.createGame();
        socketService.notifyGameCreated(socketId, newGame.gameId);
        this.store.createGame(newGame);
        this.socketGames.set(socketId, newGame.gameId);
        socketService.joinRoom(socketId, newGame.gameId);
        console.log(`Game ${newGame.gameId} was created`);
    }

    joinGame(socketId: string, gameId: string, playerUUID: string | null): void {
        const game = this.getGameById(gameId);

        // A socket that already holds a seat in this game is rejoining, not joining twice.
        // Emitting joinGame twice used to create a second seat on the same socket: two
        // players shared one socketId, one of them consumed a role and could never act,
        // and the client received alternating snapshots.
        const boundSeat = this.socketSeats.get(socketId);
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

        this.bindSocketToSeat(game.gameId, playerUUID, socketId);
        this.socketGames.set(socketId, game.gameId);
        socketService.joinRoom(socketId, game.gameId);
        this.broadcastStateAndStore(game);
        console.log(`Player ${playerUUID} joined game ${gameId}`);
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
        else throw new Error(`Game with ID ${gameId} is not in Phase DAY or in Phase SHERIFF_ELECTION, so voting cannot happen right now`);
        this.checkGameOver(game);
        this.broadcastStateAndStore(game);
    }

    nominate(gameId: any, socketId: string, nominationUUID: any): void | Promise<void> {
        const game = this.getGameById(gameId);
        const player = this.getPlayerBySocketId(game, socketId);
        if(!player.isAlive) return;
        if(game.phase === Phase.DAY) VoteHandler.nominate(game, player, nominationUUID);
        else throw new Error(`Game with ID ${gameId} is not in Phase DAY, so nomination cannot happen right now`);
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