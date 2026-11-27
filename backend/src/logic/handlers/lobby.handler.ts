import { Phase } from "@shared/phases.js";
import { v4 as uuidv4 } from 'uuid';
import type { Game, Player } from "../../models.js";
import { Role, ROLES } from "@shared/roles.js";
import { getNextToWakeUp } from "../selectors/night.selectors.js";
import { GameStore } from "../../store/game.store.js";
import { logEvent } from "../../debug/log.js";

// Minimum number of players required to leave the lobby.
// 4 = one werewolf + three villagers is the smallest setup where the village has a
// realistic chance to vote out the wolf before the night kills decide the game.
export const MIN_PLAYERS = 4;
export const MAX_NAME_LENGTH = 40;
const GAME_ID_LENGTH = 4;
const GAME_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const MAX_GAME_ID_ATTEMPTS = 1000;

const randomGameId = (): string => {
    let id = "";
    for (let i = 0; i < GAME_ID_LENGTH; i++) {
        id += GAME_ID_ALPHABET[Math.floor(Math.random() * GAME_ID_ALPHABET.length)];
    }
    return id;
}

const generateGameId = (isTaken: (gameId: string) => boolean): string => {
    for (let attempt = 0; attempt < MAX_GAME_ID_ATTEMPTS; attempt++) {
        const candidate = randomGameId();
        if (!isTaken(candidate)) return candidate;
    }
    throw new Error(`Could not generate a unique game id after ${MAX_GAME_ID_ATTEMPTS} attempts`);
}

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
    // The default uniqueness check looks at the live GameStore, so a new id can never
    // silently overwrite a running game. Callers usually pass nothing.
    createGame(isGameIdTaken: (gameId: string) => boolean = (gameId) => GameStore.getInstance().hasGame(gameId)): Game {
        const newGameId = generateGameId(isGameIdTaken);
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
            createdAt: Date.now(),
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
        // Untyped socket payload: without this a missing or numeric name lands in the snapshot
        // as `undefined` or `42`. An empty name is allowed on purpose (closeJoining renames
        // unnamed players), anything that is not a string is not.
        if(typeof newName !== 'string') throw new Error(`Name must be a string, got ${typeof newName}`);
        player.displayName = newName.trim().slice(0, MAX_NAME_LENGTH);
        logEvent("info", "player.renamed", { game: game.gameId, player: player.playerUUID, name: player.displayName });
    },
    closeJoining(game: Game): void {
        if(game.phase !== Phase.LOBBY) throw new Error(`Game ${game.gameId} is already in progress, so joining cannot be closed.`);
        if(game.players.length < MIN_PLAYERS) throw new Error(`Game ${game.gameId} only has ${game.players.length} players, but at least ${MIN_PLAYERS} are required to start a game.`);
        game.phase = Phase.ROLE_SELECTION;
        // name unnamed players
        const playersWithoutName = game.players.filter(p => !p.displayName);
        let i = 1;
        playersWithoutName.forEach(p => p.displayName = `Unnamed Player ${i++}`);
    },
    roleDistribution(game: Game, roles: Record<Role, number>): void {
        if(game.phase !== Phase.ROLE_SELECTION) throw new Error(`Game ${game.gameId} is currently not in phase ROLE_SELECTION, so Distribution cannot start!`);
        if(game.players === undefined) throw new Error(`No players are defined in game ${game.gameId}`);

        const requestedRoles = Object.entries(roles) as [string, number][];

        // 1. validate the requested composition completely before touching any player
        let totalRoles = 0;
        for (const [roleKey, amount] of requestedRoles) {
            if (!Object.prototype.hasOwnProperty.call(ROLES, roleKey)) {
                throw new Error(`Unknown role ${roleKey} in role distribution for game ${game.gameId}`);
            }
            if (!Number.isInteger(amount) || amount < 0) {
                throw new Error(`Invalid amount ${amount} for role ${roleKey} in game ${game.gameId}`);
            }
            totalRoles += amount;
        }
        if (totalRoles !== game.players.length) {
            throw new Error(`Total roles assigned (${totalRoles}) does not match number of players (${game.players.length})`);
        }
        if (!requestedRoles.some(([roleKey, amount]) => roleKey === Role.WEREWOLF && amount > 0)) {
            throw new Error(`Game ${game.gameId} needs at least one Werewolf to be playable`);
        }
        if (!requestedRoles.some(([roleKey, amount]) => amount > 0 && ROLES[roleKey as Role].wakesUp)) {
            throw new Error(`Game ${game.gameId} needs at least one role that wakes up in the night, otherwise the game cannot start`);
        }

        // 2. compute the full assignment, then write it in one go (all-or-nothing)
        const shuffledPlayerIndices: number[] = shuffledIndices(game.players.length);
        const assignment: [Player, Role][] = [];

        let i: number = 0;
        requestedRoles.forEach(([roleKey, amount]) => {
            for (let j = i; j < i + amount; j++) {
                const playerIndex = shuffledPlayerIndices[j];
                if (playerIndex === undefined) throw new Error(`No index found in shuffledPlayerIndices at position ${j}`);
                const player = game.players[playerIndex];
                if (!player) throw new Error(`Player index ${playerIndex} does not exist in game ${game.gameId}`)
                assignment.push([player, roleKey as Role]);
            }
            i += amount;
        });

        assignment.forEach(([player, role]) => {
            player.role = role;
        });

        game.phase = Phase.DISTRIBUTION;
        logEvent("info", "roles.distributed", { game: game.gameId, players: game.players.length, composition: roles });
    },
    // when gm starts game
    startGame(game: Game): void {
        if(game.phase !== Phase.DISTRIBUTION) throw new Error(`Game ${game.gameId} is not currently in the right phase to be started!`);

        // resolve the first night role first, so a failing start leaves the game untouched
        const firstNightRole = getNextToWakeUp(game, true);
        if(!firstNightRole) throw new Error(`Game ${game.gameId} does not have an active night role, although the game should start!`);

        game.phase = Phase.NIGHT;
        game.activeNightRole = firstNightRole;
        logEvent("info", "game.started", { game: game.gameId, firstRole: firstNightRole });
    }

}