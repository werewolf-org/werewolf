import { Server, Socket } from 'socket.io';
import { GameManager } from './logic/game.manager.js';
import { socketService } from './socket.service.js';
import { WerewolfHandler, RedLadyHandler, SeerHandler, CupidHandler, WitchHandler } from './logic/handlers/role.handler.js';
import { Role } from '@shared/roles.js';
import { journal } from './debug/journal.js';
import { logEvent } from './debug/log.js';

const gameManager = new GameManager();

const handleErrors = <T extends any[]>(event: string, handler: (...args: T) => void | Promise<void>, socket: Socket) => {
    return async (...args: T) => {
        const payload = args[0] as Record<string, unknown> | null | undefined;
        const gameId = payload && typeof payload === 'object' && typeof payload.gameId === 'string'
            ? payload.gameId
            : null;
        const seat = gameManager.describeSocket(socket.id);
        const payloadPlayerUUID = payload && typeof payload === 'object' && typeof payload.playerUUID === 'string'
            ? payload.playerUUID
            : null;
        // Only trust the socket -> seat map for the game this event claims: a socket still
        // bound to game A can emit an event for game B, and the journal for B must not
        // attribute it to an A seat.
        const playerUUID = (gameId && seat?.gameId === gameId ? seat.playerUUID : null) ?? payloadPlayerUUID;

        // Only games that exist get a per-game journal: otherwise any client could create
        // one journal per random id it invents, and the black box would leak memory.
        const action = gameId && gameManager.knowsGame(gameId)
            ? journal.beginAction(gameId, event, socket.id, playerUUID, payload)
            : null;
        if (!action) {
            // createGame and joins to unknown ids have no game to attach to yet.
            logEvent('info', 'action', { event, game: gameId, socket: socket.id, player: playerUUID, payload });
        }

        const startedAt = Date.now();
        try {
            // Payloads come from the network untyped and every handler destructures them. A
            // `null` payload used to surface as "Cannot destructure property 'gameId' of ...".
            if(payload !== undefined && (payload === null || typeof payload !== 'object')) {
                throw new Error(`Malformed event payload: expected an object, got ${payload === null ? 'null' : typeof payload}`);
            }
            await handler(...args);
            action?.finish(true, Date.now() - startedAt);
        } catch (error: any) {
            const message = error?.message ?? String(error);
            action?.finish(false, Date.now() - startedAt, message);
            if (!action) {
                logEvent('warn', 'rejected', { event, game: gameId, socket: socket.id, player: playerUUID, error: message });
            }
            socketService.notifyError(socket.id, message);
        }
    };
};

export function registerSocketEvents(io: Server): void {
    io.on('connection', (socket) => {
        logEvent('info', 'socket.connected', { socket: socket.id });
        const withError = <T extends any[]>(event: string, handler: (...args: T) => void | Promise<void>) => handleErrors(event, handler, socket);

        socket.on('createGame', withError('createGame', () => gameManager.createGame(socket.id)));

        socket.on('joinGame', withError('joinGame', ({ gameId, playerUUID }) => gameManager.joinGame(socket.id, gameId, playerUUID)));

        socket.on('changeName', withError('changeName', ({ gameId, playerName }) => gameManager.changeName(gameId, socket.id, playerName)));

        socket.on('closeJoining', withError('closeJoining', ({ gameId }) => gameManager.closeJoining(gameId, socket.id)));

        socket.on('roleDistribution', withError('roleDistribution', ({ gameId, roles }) => gameManager.roleDistribution(gameId, socket.id, roles)));

        socket.on('startGame', withError('startGame', ({ gameId }) => gameManager.startGame(gameId, socket.id)));

        // WEREWOLF
        socket.on('werewolfVote', withError('werewolfVote', ({ gameId, targetUUID }) => gameManager.nightAction(gameId, socket.id, Role.WEREWOLF, WerewolfHandler.handleVote, targetUUID)));

        // RED LADY
        socket.on('sleepover', withError('sleepover', ({ gameId, sleepoverUUID }) => gameManager.nightAction(gameId, socket.id, Role.RED_LADY, RedLadyHandler.handleSleepover, sleepoverUUID)));

        // SEER
        socket.on('revealRole', withError('revealRole', ({ gameId, revealUUID }) => gameManager.nightAction(gameId, socket.id, Role.SEER, SeerHandler.handleRevealingRole, revealUUID)));
        socket.on('seerConfirmed', withError('seerConfirmed', ({ gameId }) => gameManager.nightAction(gameId, socket.id, Role.SEER, SeerHandler.handleConfirm)));

        // CUPID
        socket.on('bindLovers', withError('bindLovers', ({ gameId, firstPlayerUUID, secondPlayerUUID }) => gameManager.nightAction(gameId, socket.id, Role.CUPID, CupidHandler.handleBindLovers, firstPlayerUUID, secondPlayerUUID)));
        socket.on('confirmLoverBond', withError('confirmLoverBond', ({ gameId }) => gameManager.nightAction(gameId, socket.id, null, CupidHandler.handleLoverConfirmsBond)));

        // WITCH
        socket.on('usePotion', withError('usePotion', ({ gameId, heal, killUUID }) => gameManager.nightAction(gameId, socket.id, Role.WITCH, WitchHandler.handlePotion, heal, killUUID)));
        socket.on('witchConfirms', withError('witchConfirms', ({ gameId }) => gameManager.nightAction(gameId, socket.id, Role.WITCH, WitchHandler.handleConfirm)));

        // DAY
        socket.on('nominate', withError('nominate', ({ gameId, nominationUUID }) => gameManager.nominate(gameId, socket.id, nominationUUID)));
        socket.on('vote', withError('vote', ({ gameId, voteTargetUUID }) => gameManager.vote(gameId, socket.id, voteTargetUUID)));

        socket.on('readyForNight', withError('readyForNight', ({ gameId }) => gameManager.readyForNight(gameId, socket.id)));

        socket.on('acceptSheriffRole', withError('acceptSheriffRole', ({ gameId }) => gameManager.acceptSheriffRole(gameId, socket.id)));

        // Game manager escape hatch: advance a stuck phase by one step
        socket.on('managerAdvance', withError('managerAdvance', ({ gameId }) => gameManager.managerAdvance(gameId, socket.id)));

        socket.on('disconnect', (reason) => {
            logEvent('info', 'socket.disconnected', { socket: socket.id, reason });
            gameManager.handleDisconnect(socket.id);
        });
    });
}
