import { Server } from 'socket.io';
import type { Snapshot } from '@shared/snapshot.js';

export class SocketService {
    private static instance: SocketService;
    private io: Server | null = null;

    private constructor() {}

    public static getInstance(): SocketService {
        if (!SocketService.instance) {
            SocketService.instance = new SocketService();
        }
        return SocketService.instance;
    }

    public init(io: Server) {
        this.io = io;
    }

    private getIO(): Server {
        if (!this.io) {
            throw new Error('SocketService not initialized! Call init(io) first.');
        }
        return this.io;
    }

    // --- Room Management ---

    public joinRoom(socketId: string, roomId: string) {
        const socket = this.getIO().sockets.sockets.get(socketId);
        if (socket) {
            socket.join(roomId);
        }
    }

    public leaveRoom(socketId: string, roomId: string) {
        const socket = this.getIO().sockets.sockets.get(socketId);
        if (socket) {
            socket.leave(roomId);
        }
    }

    // --- Generic Emitters ---

    public emitToRoom(roomId: string, event: string, data: any) {
        this.getIO().to(roomId).emit(event, data);
    }

    public emitToPlayer(socketId: string, event: string, data: any) {
        this.getIO().to(socketId).emit(event, data);
    }

    // --- Game Specific Emitters (Domain Logic) ---

    public syncState(socketId: string | null, localState: Snapshot) {
        if(socketId) this.emitToPlayer(socketId, 'syncState', localState)
    }

    public notifyGameCreated(socketId: string, gameId: string) {
        this.emitToPlayer(socketId, 'gameCreated', { gameId });
    }

    public notifyPlayerJoined(socketId: string, data: { gameId: string, playerUUID: string }) {
        this.emitToPlayer(socketId, 'joinedGame', data);
    }

    // --- Error Handling ---

    // The caller (socket.routes) has already written the structured rejection line, so
    // this stays a pure delivery method: one event, one log line.
    public notifyError(socketId: string, message: string) {
        this.emitToPlayer(socketId, 'error', { message });
    }
}

export const socketService = SocketService.getInstance();