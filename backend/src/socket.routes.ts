import { Server, Socket } from 'socket.io';
import { GameManager } from './logic/game.manager.js';
import { socketService } from './socket.service.js';
import { WerewolfHandler, RedLadyHandler, SeerHandler, CupidHandler, WitchHandler } from './logic/handlers/role.handler.js';
import { Role } from '@shared/roles.js';

const gameManager = new GameManager();

const handleErrors = <T extends any[]>(handler: (...args: T) => void | Promise<void>, socket: Socket) => {
    return async (...args: T) => {
        try {
            await handler(...args);
        } catch (error: any) {
            socketService.notifyError(socket.id, error.message);
        }
    };
};

export function registerSocketEvents(io: Server): void {
    io.on('connection', (socket) => {
        console.log('User connected:', socket.id);
        const withError = <T extends any[]>(handler: (...args: T) => void | Promise<void>) => handleErrors(handler, socket);

        socket.on('createGame', withError(() => gameManager.createGame(socket.id)));

        socket.on('joinGame', withError(({ gameId, playerUUID }) => gameManager.joinGame(socket.id, gameId, playerUUID)));

        socket.on('changeName', withError(({ gameId, playerName }) => gameManager.changeName(gameId, socket.id, playerName)));

        socket.on('closeJoining', withError(({ gameId }) => gameManager.closeJoining(gameId)));

        socket.on('roleDistribution', withError(({ gameId, roles }) => gameManager.roleDistribution(gameId, roles)));

        socket.on('startGame', withError(({ gameId }) => gameManager.startGame(gameId)));

        // WEREWOLF
        socket.on('werewolfVote', withError(({ gameId, targetUUID }) => gameManager.nightAction(gameId, socket.id, Role.WEREWOLF, WerewolfHandler.handleVote, targetUUID)));

        // RED LADY
        socket.on('sleepover', withError(({ gameId, sleepoverUUID }) => gameManager.nightAction(gameId, socket.id, Role.RED_LADY, RedLadyHandler.handleSleepover, sleepoverUUID)));

        // SEER
        socket.on('revealRole', withError(({ gameId, revealUUID }) => gameManager.nightAction(gameId, socket.id, Role.SEER, SeerHandler.handleRevealingRole, revealUUID)));
        socket.on('seerConfirmed', withError(({ gameId }) => gameManager.nightAction(gameId, socket.id, Role.SEER, SeerHandler.handleConfirm)));

        // CUPID
        socket.on('bindLovers', withError(({ gameId, firstPlayerUUID, secondPlayerUUID }) => gameManager.nightAction(gameId, socket.id, Role.CUPID, CupidHandler.handleBindLovers, firstPlayerUUID, secondPlayerUUID)));
        socket.on('confirmLoverBond', withError(({ gameId }) => gameManager.nightAction(gameId, socket.id, null, CupidHandler.handleLoverConfirmsBond)));

        // WITCH
        socket.on('usePotion', withError(({ gameId, heal, killUUID }) => gameManager.nightAction(gameId, socket.id, Role.WITCH, WitchHandler.handlePotion, heal, killUUID)));
        socket.on('witchConfirms', withError(({ gameId }) => gameManager.nightAction(gameId, socket.id, Role.WITCH, WitchHandler.handleConfirm)));

        // DAY
        socket.on('nominate', withError(({ gameId, nominationUUID }) => gameManager.nominate(gameId, socket.id, nominationUUID)));
        socket.on('vote', withError(({ gameId, voteTargetUUID }) => gameManager.vote(gameId, socket.id, voteTargetUUID)));

        socket.on('readyForNight', withError(({ gameId }) => gameManager.readyForNight(gameId, socket.id)));

        socket.on('acceptSheriffRole', withError(({ gameId }) => gameManager.acceptSheriffRole(gameId, socket.id)));

        socket.on('disconnect', () => {
            console.log('User disconnected:', socket.id);
            // TODO: possibly remove socketid from player in game-store
        });
    });
}
