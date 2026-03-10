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

    private getGameById(gameId: string): Game {
        const game = this.store.getGame(gameId);
        if(!game) throw new Error(`Game with ID ${gameId} not found`);
        return game;
    }

    private getPlayerBySocketId(game: Game, socketId: string): Player {
        const player = game.players.find((player) => player.socketId === socketId);
        if(!player) throw new Error(`Player with socketId ${socketId} not found in ${game.gameId}`);
        return player;
    }

    private broadcastStateAndStore(game: Game) {
        const playersWithSocket: Player[] = game.players.filter((player) => player.socketId);
        playersWithSocket.forEach((player) => socketService.syncState(player.socketId, getLocalPlayerState(game, player)));
        this.store.updateGame(game);
    }

    // TODO: outsource to other file
    private checkGameOver(game: Game) {
        // TODO: make end of game logic more elaborate (e.g. if 3 werewolves + 1 villager => village cannot win)
        const alivePlayers = game.players.filter((player) => player.isAlive);
        if(alivePlayers.length === 0) { // no more players alive
            game.phase = Phase.GAME_OVER;
            game.winningTeam = null;
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
        const isInLove = (player: Player) => player.lovePartner != null;
        if(alivePlayers.length === 2 && alivePlayers.every(isInLove)) {
            game.phase = Phase.GAME_OVER;
            game.winningTeam = 'couple'; // only couple lives
        }
    }

    createGame(socketId: string): void {
        const newGame = LobbyHander.createGame();
        socketService.notifyGameCreated(socketId, newGame.gameId);
        this.store.createGame(newGame);
        socketService.joinRoom(socketId, newGame.gameId);
        console.log(`Game ${newGame.gameId} was created`);
    }

    joinGame(socketId: string, gameId: string, playerUUID: string): void {
        const game = this.getGameById(gameId);

        if(game.phase === Phase.LOBBY) {
            // JOIN game (in Lobby Phase)
            playerUUID = LobbyHander.createNewPlayer(game, socketId);
            socketService.notifyPlayerJoined(socketId, {
                gameId: gameId,
                playerUUID: playerUUID,
            })
        } else {
            // REJOIN game (e.g. after Refreshing Page)
            LobbyHander.connectPlayerToSocket(game, playerUUID, socketId);
        }

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

    closeJoining(gameId: string): void {
        const game = this.getGameById(gameId);
        LobbyHander.closeJoining(game);
        this.broadcastStateAndStore(game);
    }

    roleDistribution(gameId: string, roles: Record<Role, number>): void {
        const game = this.getGameById(gameId);
        LobbyHander.roleDistribution(game, roles);
        this.broadcastStateAndStore(game);
    }

    startGame(gameId: string): void {
        const game = this.getGameById(gameId);
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
        checkPlayerNightRole(game, player, role);

        const nextRole: boolean = handler(game, player, ...handlerArgs);
        if(nextRole) NightHandler.nextRole(game);
        this.checkGameOver(game);
        this.broadcastStateAndStore(game);
    }
    
    // both for sheriff election and lynch voting
    vote(gameId: string, socketId: string, targetUUID: string): void {
        const game = this.getGameById(gameId);
        const player = this.getPlayerBySocketId(game, socketId);
        if(game.phase === Phase.DAY) VoteHandler.castLynchVote(game, player, targetUUID);
        else if(game.phase === Phase.SHERIFF_ELECTION) VoteHandler.castSheriffVote(game, player, targetUUID);
        else throw new Error(`Game with ID ${gameId} is not in Phase DAY or in Phase SHERIFF_ELECTION, so voting cannot happen right now`);
        this.checkGameOver(game);
        this.broadcastStateAndStore(game);
    }

    acceptSheriffRole(gameId: string, socketId: string) {
        const game = this.getGameById(gameId);
        const player = this.getPlayerBySocketId(game, socketId);
        VoteHandler.acceptSheriffRole(game, player);
        this.broadcastStateAndStore(game);
    }

    readyForNight(gameId: string, socketId: string) {
        const game = this.getGameById(gameId);
        const player = this.getPlayerBySocketId(game, socketId);
        VoteHandler.readyForNight(game, player);
        this.broadcastStateAndStore(game);
    }
}