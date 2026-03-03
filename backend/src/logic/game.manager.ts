import { GameStore } from "../store/game.store.js";
import { type Game, type Player } from "../models.js";
import { Role, ROLES, Team } from '@shared/roles.js';
import { Phase } from "@shared/phases.js";
import { v4 as uuidv4 } from 'uuid';
import { socketService } from "../socket.service.js";
import { checkCoupleDying, getWerewolfVictimUUID, getWerewolfVotes } from "./role.handler.js";

export class GameManager {
    private store = GameStore.getInstance();

    private generateGameId(): string {
        return Math.random().toString(36).substring(2, 6).toUpperCase();
    }

    syncPlayerState(game: Game, player: Player) {
        const socketId: string | null = player.socketId;
        if(!socketId) throw new Error(`Player ${player.playerUUID} in Game ${game.gameId} does not have a socketID (${player.socketId})`);

        const redLadySleepoverUUID = player.role === Role.RED_LADY && player.nightAction ? (player.nightAction as any).sleepoverUUID : null;
        const seerRevealUUID = player.role === Role.SEER && player.nightAction ? (player.nightAction as any).revealUUID : null;
        const seerRevealRole = player.role === Role.SEER && player.nightAction ? (player.nightAction as any).revealedRole : null;

        // Aggregate werewolf votes and victim ONLY for Werewolves and Witch
        let werewolfVotes: Record<string, string> | null = null;
        let werewolfVictim: string | null = null;
        if (player.isAlive && player.role === Role.WEREWOLF) werewolfVotes = getWerewolfVotes(game);
        if (player.isAlive && (player.role === Role.WEREWOLF || player.role === Role.WITCH)) werewolfVictim = getWerewolfVictimUUID(game);

        // Cupid confirmation status
        let cupidSelectedLovers = false;
        let cupidFirstLoverConfirmed = false;
        let cupidSecondLoverConfirmed = false;
        let cupidFirstLoverUUID = null;
        let cupidSecondLoverUUID = null;
        const cupid = game.players.find((p) => p.role == Role.CUPID);
        if(cupid && cupid.nightAction) {
            cupidSelectedLovers = true;
            const firstLover = game.players.find(p => p.playerUUID === (cupid.nightAction as any).firstPlayerUUID);
            const secondLover = game.players.find(p => p.playerUUID === (cupid.nightAction as any).secondPlayerUUID);
            if(player.playerUUID === firstLover?.playerUUID || player.playerUUID === secondLover?.playerUUID || player.playerUUID === cupid.playerUUID) {
                cupidFirstLoverConfirmed = firstLover?.lovePartnerConfirmed ?? false;
                cupidSecondLoverConfirmed = secondLover?.lovePartnerConfirmed ?? false;
                cupidFirstLoverUUID = firstLover?.playerUUID;
                cupidSecondLoverUUID = secondLover?.playerUUID;
            }
        }

        const localPlayerList = game.players.map(p => ({
            playerUUID: p.playerUUID,
            displayName: p.displayName,
            isSheriff: p.playerUUID === game.sheriffUUID,
            isAlive: p.isAlive,
            role: (game.phase === Phase.GAME_OVER || !p.isAlive) ? p.role : null
        }));

        const localStatePatch: object = {
            gameId: game.gameId,
            playerUUID: player.playerUUID,
            phase: game.phase,
            activeNightRole: game.activeNightRole,
            players: localPlayerList,
            lynchDone: game.lynchDone,
            winningTeam: game.winningTeam,

            displayName: player.displayName,
            isManager: player.playerUUID === game.managerUUID,
            role: player.role,
            lovePartnerUUID: player.lovePartner,
            lovePartnerConfirmed: player.lovePartnerConfirmed,
            readyForNight: player.readyForNight,
            myVoteTargetUUID: player.voteTargetUUID,

            voteResults: this.getVoteResults(game),
            votedOutUUID: game.lastVotedOutUUID,

            werewolfVotes: werewolfVotes,
            werewolfVictim: werewolfVictim,

            witchUsedHealingPotion: player.usedHealingPotion,
            witchUsedKillingPotion: player.usedKillingPotion,

            redLadySleepoverUUID: redLadySleepoverUUID,

            seerRevealUUID: seerRevealUUID,
            seerRevealRole: seerRevealRole,

            cupidSelectedLovers: cupidSelectedLovers,
            cupidFirstLoverUUID: cupidFirstLoverUUID,
            cupidSecondLoverUUID: cupidSecondLoverUUID,
            cupidFirstLoverConfirmed: cupidFirstLoverConfirmed,
            cupidSecondLoverConfirmed: cupidSecondLoverConfirmed,
        }
        socketService.syncState(socketId, localStatePatch);
    }

    broadcastSyncState(gameId: string) {
        const game = this.store.getGame(gameId);
        if(!game) throw new Error(`Game with ID ${gameId} not found!`)
        const playersWithSocket = game.players.filter((player) => player.socketId);
        playersWithSocket.forEach((player) => this.syncPlayerState(game, player));
    }

    createGame(socketId: string): void {
        const gameId = this.generateGameId();

        const newGame: Game = {
            gameId: gameId,
            managerUUID: null,
            players: [],
            round: 0,
            phase: Phase.LOBBY,
            activeNightRole: null,
            sheriffUUID: null,
            lynchDone: false,
            lastVotedOutUUID: null,
            winningTeam: "",
        }

        socketService.notifyGameCreated(socketId, gameId);
        this.store.createGame(newGame);
        socketService.joinRoom(socketId, gameId);
        console.log(`Game ${gameId} was created`);
    }

    joinGame(socketId: string, gameId: string, playerUUID: string): void {
        const game = this.store.getGame(gameId);
        if(!game) throw new Error(`Game with ID ${gameId} not found!`)

        const newUUID = uuidv4();
        // fork: either JOIN or REJOIN game
        if(game.phase === Phase.LOBBY) {
            this.newPlayer(game.gameId, socketId, newUUID);
            playerUUID = newUUID;
        }
        
        const playerWithID = game.players.find((player) => player.playerUUID == playerUUID);
        if(!playerWithID) throw new Error(`Player with UUID ${playerUUID} not found in Game`);
        playerWithID.socketId = socketId;

        socketService.joinRoom(socketId, game.gameId);
        this.broadcastSyncState(game.gameId);
        console.log(`Player ${playerUUID} joined game ${gameId}`);
    }
    
    private newPlayer(gameId: string, socketId: string, playerUUID: string): void {
        const game = this.store.getGame(gameId);
        if(!game) throw new Error(`Game with ID ${gameId} not found!`)
        const isManager = game.players.length === 0;
        if(isManager) game.managerUUID = playerUUID;
        const newPlayer: Player = {
            displayName: '',
            role: null,
            voteTargetUUID: null,
            socketId: socketId,
            playerUUID: playerUUID, 
            nightAction: null,
            isAlive: true,
            lovePartner: null,
            lovePartnerConfirmed: false,
            usedHealingPotion: false,
            usedKillingPotion: false,
            readyForNight: false
        }

        game?.players.push(newPlayer);
        socketService.notifyPlayerJoined(socketId, {
          gameId: gameId,
          playerUUID: playerUUID,
        })
        this.store.updateGame(game);
    }

    changeName(gameId: string, playerUUID: string, playerName: string): void {
        const game = this.store.getGame(gameId);
        if(!game) throw new Error(`Game with ID ${gameId} not found!`);
        if(game.phase !== Phase.LOBBY) throw new Error(`Game with ID ${game.gameId} not in Phase LOBBY, so name change not possible!`);
        const playerWithID = game.players.find((player) => player.playerUUID == playerUUID);
        if(!playerWithID) throw new Error(`Player with UUID ${playerUUID} not found in Game`);
        playerWithID.displayName = playerName;
        console.log(`Player ${playerUUID} changed name to ${playerName}`)
        this.broadcastSyncState(gameId);
        this.store.updateGame(game);
    }

    closeJoining(gameId: string): void {
        const game = this.store.getGame(gameId);
        if(!game) throw new Error(`Game with ID ${gameId} not found!`)
        if(game.phase !== Phase.LOBBY) throw new Error(`Game ${gameId} is already in progress, so joining cannot be closed.`);

        game.phase = Phase.ROLE_SELECTION;
        this.broadcastSyncState(gameId);
        this.store.updateGame(game);
    }

    private shuffledIndices(n: number): number[] {
        const a = Array.from({ length: n }, (_, i) => i);

        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));

            const tmp = a[i]!;
            a[i] = a[j]!;
            a[j] = tmp;
        }
        return a;
    }

    startDistribution(gameId: string, roles: Record<Role, number>): void {
        const game = this.store.getGame(gameId);
        if(!game) throw new Error(`Game with ID ${gameId} not found!`)
        if(game.phase !== Phase.ROLE_SELECTION) throw new Error(`Game ${gameId} is currently not in phase ROLE_SELECTION, so Distribution cannot start!`);
        if(game.players === undefined) throw new Error(`No players are defined in game ${gameId}`);

        const totalRoles = Object.values(roles).reduce((sum, count) => sum + (count as number), 0);
        if (totalRoles !== game.players.length) {
            throw new Error(`Total roles assigned (${totalRoles}) does not match number of players (${game.players.length})`);
        }

        const shuffledPlayerIndices: number[] = this.shuffledIndices(game.players.length);

        let i: number = 0;
        Object.entries(roles).forEach(([role, amount]) => {
            for (let j = i; j < i + (amount as number); j++) {
                const playerIndex = shuffledPlayerIndices[j];
                if (playerIndex === undefined) throw new Error(`No index found in shuffledPlayerIndices at position ${j}`);
                const player = game.players[playerIndex];
                if (!player) throw new Error(`Player index ${playerIndex} does not exist in game ${gameId}`)
                player.role = role as Role; 
            }
            i += amount as number;
        });

        game.phase = Phase.DISTRIBUTION;
        console.log(`Roles distributed for game ${gameId}`);
        this.broadcastSyncState(gameId);
        this.store.updateGame(game);
    }

    startGame(gameId: string): void {
        const game = this.store.getGame(gameId);
        if(!game) throw new Error(`Game with ID ${gameId} not found!`)
        if(game.phase !== Phase.DISTRIBUTION) throw new Error(`Game ${gameId} is not currently in the right phase to be started!`);
        game.phase = Phase.NIGHT;
        game.activeNightRole = this.getFirstToWakeUp(game);
        if(!game.activeNightRole) throw new Error(`Game ${game.gameId} does not have an active night role (${game.activeNightRole}), although the game started!`);
        console.log(`Game ${gameId} started...`)
        this.isGameOver(gameId);
        this.broadcastSyncState(gameId);
        this.store.updateGame(game);
    }

    private getFirstToWakeUp(game: Game): Role | null {
        const rolesInGame = new Set(game.players.filter(p => p.isAlive).map(p => p.role));

        // Determine the order of roles that wake up this night
        const wakeOrder = (Object.keys(ROLES) as Role[])
            .filter(role => {
                const def = ROLES[role];
                const isRoleInGame = rolesInGame.has(role);
                const isFirstNightOnly = def.onlyFirstNight;
                const isFirstNight = game.round === 0;

                return def.wakesUp && isRoleInGame && (!isFirstNightOnly || isFirstNight);
            })
            .sort((a, b) => ROLES[a].nightOrder - ROLES[b].nightOrder);
        
        return wakeOrder[0] ?? null;
    }

    // if role === null: Role does not matter
    // e.g. in Cupid phase also non cupid players do actions (lovePartnerConfirms)
    private getPlayerFromNight(game: Game, socketId: string, role: Role | null): Player {
        if(game.phase !== Phase.NIGHT) throw new Error(`Game ${game.gameId} is not current in Night Phase, cannot do Night Action!`);

        // check if player exists & has correct role
        const player = game.players.find((player) => player.socketId === socketId);
        if(!player) throw new Error(`Player with socketId ${socketId} not found in ${game.gameId}`);
        if(role) {
            if(player.role !== role) throw new Error(`Player with UUID ${player.playerUUID} does not have the correct role to do the night action of the role (${player.role} !== ${role})`);
            if(ROLES[player.role].wakesUp === false) throw new Error(`Player ${player.playerUUID} has role ${player.role}, but it doesnt wake up in the night`);
        }
        return player;
    }

    nightAction<T extends any[]> (gameId: string, socketId: string, role: Role | null,
        handler: (game: Game, player: Player, ...args: T) => void,
        ...handlerArgs: T
    ): void {
        const game = this.store.getGame(gameId);
        if (!game) throw new Error(`Game with ID ${gameId} not found!`);
        const player = this.getPlayerFromNight(game, socketId, role);

        handler(game, player, ...handlerArgs);
        this.isGameOver(gameId);
        this.broadcastSyncState(gameId);
        this.store.updateGame(game);
    }

    vote(gameId: string, socketId: string, targetUUID: string): void {
        const game = this.store.getGame(gameId);
        if(!game) throw new Error(`Game with ID ${gameId} not found!`)
        if(game.phase !== Phase.DAY) throw new Error(`Game with ID ${gameId} is not in Phase DAY, so voting cannot happen right now`);
        if(game.lynchDone) throw new Error(`Cannot vote in Game ${game.gameId} since lynch is already done!`);
        
        const player = game.players.find((player) => player.socketId === socketId);
        if(!player) throw new Error(`Player with socketId ${socketId} not found in ${gameId}`);
        if(player.voteTargetUUID) throw new Error(`Player with socketId ${socketId} already voted`)
        
        player.voteTargetUUID = targetUUID;

        const everyoneVoted: boolean = this.checkIfEveryoneVoted(game);
        if(everyoneVoted) this.resolveVoting(game);

        this.broadcastSyncState(gameId);
        this.store.updateGame(game);
    }

    private checkIfEveryoneVoted(game: Game): boolean {
        if(game.phase !== Phase.DAY) throw new Error(`Game with ID ${game.gameId} is not in Phase DAY, so voting cannot happen right now`)

        const alivePlayers = game.players.filter((player) => player.isAlive)
        const playersWhoVotes = alivePlayers.filter((player) => player.voteTargetUUID !== null);
        return playersWhoVotes.length === alivePlayers.length;
    }

    private getVoteResults(game: Game): Record<string, string | null> | null {
        if(game.phase !== Phase.DAY) return null;
        return Object.fromEntries(
            game.players
                .filter(p => p.playerUUID !== null)
                .map(p => [p.playerUUID, p.voteTargetUUID])
        );
    }

    private getVotedOut(game: Game): Player | null {
        const votes: Record<string, number> = {}
        const alivePlayers = game.players.filter((player) => player.isAlive)
        if(alivePlayers.length === 0) return null;
        for (const player of alivePlayers) {
            if(player.voteTargetUUID) votes[player.voteTargetUUID] = (votes[player.voteTargetUUID] ?? 0) + 1;
        }
        const entries = Object.entries(votes);
        if (entries.length === 0) throw new Error("No votes present");

        const maxCount = Math.max(...Object.entries(votes).map(([, count]) => count));
        const electedPlayers = entries
            .filter(([, count]) => count === maxCount)
            .map(([uuid]) => uuid); 

        let electedPlayerUUID: string | null = null;
        if(electedPlayers.length === 1) electedPlayerUUID = electedPlayers[0] ?? null;
        else if(electedPlayers.length > 1) {
            const sheriff = alivePlayers.find((player) => player.playerUUID === game.sheriffUUID);
            if(sheriff && sheriff.isAlive && sheriff.voteTargetUUID && electedPlayers.includes(sheriff.voteTargetUUID)) electedPlayerUUID = sheriff.voteTargetUUID;
        }

        const electedPlayer = alivePlayers.find((player) => player.playerUUID === electedPlayerUUID) ?? null;
        return electedPlayer;
    }
    
    private resolveVoting(game: Game): void {
        if(game.phase !== Phase.DAY) throw new Error(`Game with ID ${game.gameId} is not in Phase DAY, so voting cannot happen right now`);
        if(!game.players.find((player) => player.voteTargetUUID)) throw new Error(`Not all players in Game ${game.gameId} have voted!`);

        const electedPlayer = this.getVotedOut(game); 
        if(electedPlayer) {
            electedPlayer.isAlive = false;
            checkCoupleDying(game, electedPlayer.playerUUID);
        }

        // reset votes
        game.lynchDone = true;
        game.lastVotedOutUUID = electedPlayer?.playerUUID ?? null;
        this.isGameOver(game.gameId);
        console.log(`Voting Resolved in Game ${game.gameId}. Player voted out: ${electedPlayer?.playerUUID}`)
    }

    readyForNight(gameId: string, socketId: string) {
        const game = this.store.getGame(gameId);
        if (!game) throw new Error(`Game with ID ${gameId} not found!`);
        if(game.phase !== Phase.DAY) throw new Error(`Game ${game.gameId} is not currently in Day Phase (Phase: ${game.phase}), cannot confirm ready for night`);
        const player = game.players.find((player) => player.socketId === socketId);
        if(!player) throw new Error(`Player with socketId ${socketId} not found in ${game.gameId}`);
        if(!player.isAlive) throw new Error(`Player with socketId ${socketId} is not alive anymore in game ${game.gameId}`);
        player.readyForNight = true;

        const alivePlayers = game.players.filter((player) => player.isAlive)
        const readyPlayers = alivePlayers.filter((player) => player.readyForNight);
        if(alivePlayers.length === readyPlayers.length) {
            // go to night phase
            game.round = game.round + 1;
            game.phase = Phase.NIGHT;
            game.activeNightRole = this.getFirstToWakeUp(game);
            game.players.forEach((player) => player.voteTargetUUID = null);
            game.lynchDone = false;
            if(!game.activeNightRole) throw new Error(`Game with ID ${gameId} cannot go to Night, no first night role`)
            game.players.forEach((player) => player.readyForNight = false);
        }
        this.broadcastSyncState(gameId);
        this.store.updateGame(game);
    }

    // TODO: make end of game logic more elaborate (e.g. if 3 werewolves + 1 villager => village cannot win)
    isGameOver(gameId: string) {
        const game = this.store.getGame(gameId);
        if (!game) throw new Error(`Game with ID ${gameId} not found!`);
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

}