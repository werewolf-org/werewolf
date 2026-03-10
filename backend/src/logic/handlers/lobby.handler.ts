import { Phase } from "@shared/phases.js";
import { v4 as uuidv4 } from 'uuid';
import type { Game, Player } from "../../models.js";
import type { Role } from "@shared/roles.js";
import { getNextToWakeUp } from "../selectors/night.selectors.js";

const generateGameId = (): string => Math.random().toString(36).substring(2, 6).toUpperCase();
const shuffledIndices = (n: number): number[] => {
    const a = Array.from({ length: n }, (_, i) => i);

    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));

        const tmp = a[i]!;
        a[i] = a[j]!;
        a[j] = tmp;
    }
    return a;
}

export const LobbyHander = {
    createGame(): Game {
        const newGameId = generateGameId();
        const newGame: Game = {
            gameId: newGameId,
            managerUUID: null,
            players: [],
            round: 0,
            phase: Phase.LOBBY,
            activeNightRole: null,
            sheriffUUID: null,
            sheriffElectionDone: false,
            lynchDone: false,
            lastVotedOutUUID: null,
            winningTeam: "",
        }
        return newGame;
    },
    // initialize player after join game in LOBBY Phase
    createNewPlayer(game: Game, socketId: string): string {
        const newPlayerUUID = uuidv4();
        const isManager = game.players.length === 0;
        if(isManager) game.managerUUID = newPlayerUUID;
        const newPlayer: Player = {
            displayName: '',
            role: null,
            nominationUUID: null,
            voteTargetUUID: null,
            socketId: socketId,
            playerUUID: newPlayerUUID, 
            nightAction: null,
            isAlive: true,
            lovePartner: null,
            lovePartnerConfirmed: false,
            usedHealingPotion: false,
            usedKillingPotion: false,
            readyForNight: false
        }
        game.players.push(newPlayer);
        return newPlayerUUID;
    },
    // re-join game
    connectPlayerToSocket(game: Game, playerUUID: string, socketId: string): void {
        const playerWithID = game.players.find((player) => player.playerUUID == playerUUID);
        if(!playerWithID) throw new Error(`Player with UUID ${playerUUID} not found in Game`);
        playerWithID.socketId = socketId;
    },
    changeName(game: Game, player: Player, newName: string): void {
        if(game.phase !== Phase.LOBBY) throw new Error(`Game with ID ${game.gameId} not in Phase LOBBY, so name change not possible!`);
        player.displayName = newName;
        console.log(`Player ${player.playerUUID} changed name to ${newName}`)
    },
    closeJoining(game: Game): void {
        if(game.phase !== Phase.LOBBY) throw new Error(`Game ${game.gameId} is already in progress, so joining cannot be closed.`);
        game.phase = Phase.ROLE_SELECTION;
        // name unnamed players
        const playersWithoutName = game.players.filter(p => !p.displayName);
        let i = 1;
        playersWithoutName.forEach(p => p.displayName = `Unnamed Player ${i++}`);
    },
    roleDistribution(game: Game, roles: Record<Role, number>): void {
        if(game.phase !== Phase.ROLE_SELECTION) throw new Error(`Game ${game.gameId} is currently not in phase ROLE_SELECTION, so Distribution cannot start!`);
        if(game.players === undefined) throw new Error(`No players are defined in game ${game.gameId}`);

        const totalRoles = Object.values(roles).reduce((sum, count) => sum + (count as number), 0);
        if (totalRoles !== game.players.length) {
            throw new Error(`Total roles assigned (${totalRoles}) does not match number of players (${game.players.length})`);
        }

        const shuffledPlayerIndices: number[] = shuffledIndices(game.players.length);

        let i: number = 0;
        Object.entries(roles).forEach(([role, amount]) => {
            for (let j = i; j < i + (amount as number); j++) {
                const playerIndex = shuffledPlayerIndices[j];
                if (playerIndex === undefined) throw new Error(`No index found in shuffledPlayerIndices at position ${j}`);
                const player = game.players[playerIndex];
                if (!player) throw new Error(`Player index ${playerIndex} does not exist in game ${game.gameId}`)
                player.role = role as Role; 
            }
            i += amount as number;
        });

        game.phase = Phase.DISTRIBUTION;
        console.log(`Roles distributed for game ${game.gameId}`);
    },
    // when gm starts game
    startGame(game: Game): void {
        if(game.phase !== Phase.DISTRIBUTION) throw new Error(`Game ${game.gameId} is not currently in the right phase to be started!`);
        game.phase = Phase.NIGHT;
        game.activeNightRole = getNextToWakeUp(game, true);
        if(!game.activeNightRole) throw new Error(`Game ${game.gameId} does not have an active night role (${game.activeNightRole}), although the game started!`);
        console.log(`Game ${game.gameId} started...`)
    }

}