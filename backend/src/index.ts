import { createServer } from 'http';
import { Server } from 'socket.io';
import * as dotenv from 'dotenv';
import { GameManager } from './logic/game.manager.js';
import { socketService } from './socket.service.js';
import { CupidHandler, RedLadyHandler, SeerHandler, WerewolfHandler, WitchHandler } from './logic/handlers/role.handler.js';
import { Role } from '@shared/roles.js';

if (process.env.NODE_ENV !== "production") dotenv.config();

const origins = process.env.ORIGIN === undefined ? [] : process.env.ORIGIN.split(' ');

const httpServer = createServer((req, res) => {
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Werwolf Backend is running (with WebSockets)!');
    } else {
        res.writeHead(404);
        res.end();
    }
});

const gameManager: GameManager = new GameManager();

// ------------- SOCKET.IO ---------------
const io = new Server(httpServer, {
  cors: {
    origin: origins.length > 0 ? origins : "http://localhost:5173",
    methods: ["GET", "POST"]
  }
});

// Initialize the Singleton Service
socketService.init(io);

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // feed forward errors to frontend (for testing)
  const handleErrors = <T extends any[]>(handler: (...args: T) => void | Promise<void>) => {
    return async (...args: T) => {
      try {
        await handler(...args);
      } catch (error: any) {
        socketService.notifyError(socket.id, error.message);
      }
    };
  };

  socket.on('createGame', handleErrors(() => gameManager.createGame(socket.id)));
  
  socket.on('joinGame', handleErrors(({gameId, playerUUID}) => gameManager.joinGame(socket.id, gameId, playerUUID)));

  socket.on('changeName', handleErrors(({gameId, playerName}) => gameManager.changeName(gameId, socket.id, playerName)));

  socket.on('closeJoining', handleErrors(({gameId}) => gameManager.closeJoining(gameId)));

  socket.on('roleDistribution', handleErrors(({gameId, roles}) => gameManager.roleDistribution(gameId, roles)));

  socket.on('startGame', handleErrors(({gameId}) => gameManager.startGame(gameId)));

  // WERWOLF
  socket.on('werewolfVote', handleErrors(({gameId, targetUUID}) => gameManager.nightAction(gameId, socket.id, Role.WEREWOLF, WerewolfHandler.handleVote, targetUUID)));
  // after voting: show 'other werewolves still have to vote'

  // RED LADY
  socket.on('sleepover', handleErrors(({gameId, sleepoverUUID}) => gameManager.nightAction(gameId, socket.id, Role.RED_LADY, RedLadyHandler.handleSleepover, sleepoverUUID)));

  // SEER
  socket.on('revealRole', handleErrors(({gameId, revealUUID}) => gameManager.nightAction(gameId, socket.id, Role.SEER, SeerHandler.handleRevealingRole, revealUUID)));
  // for going to next role
  socket.on('seerConfirmed', handleErrors(({gameId}) => gameManager.nightAction(gameId, socket.id, Role.SEER, SeerHandler.handleConfirm)));

  // CUPID
  socket.on('bindLovers', handleErrors(({gameId, firstPlayerUUID, secondPlayerUUID}) => gameManager.nightAction(gameId, socket.id, Role.CUPID, CupidHandler.handleBindLovers, firstPlayerUUID, secondPlayerUUID)));
  // for going to next role
  socket.on('confirmLoverBond', handleErrors(({gameId}) => gameManager.nightAction(gameId, socket.id, null, CupidHandler.handleLoverConfirmsBond)));

  // WITCH
  socket.on('usePotion', handleErrors(({gameId, heal, killUUID}) => gameManager.nightAction(gameId, socket.id, Role.WITCH, WitchHandler.handlePotion, heal, killUUID)));
  // for going to next role
  socket.on('witchConfirms', handleErrors(({gameId}) => gameManager.nightAction(gameId, socket.id, Role.WITCH, WitchHandler.handleConfirm)));

  // DAY
  socket.on('vote', handleErrors(({gameId, voteTargetUUID}) => gameManager.vote(gameId, socket.id, voteTargetUUID)));

  // after lynch: for players to go to night
  socket.on('readyForNight', handleErrors(({gameId}) => gameManager.readyForNight(gameId, socket.id)));

  // after sheriff vote
  socket.on('acceptSheriffRole', handleErrors(({gameId}) => gameManager.acceptSheriffRole(gameId, socket.id)));

  // -----
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // TODO: possibly remove socketid from player in game-store
  });
});
// --------------------------------

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});