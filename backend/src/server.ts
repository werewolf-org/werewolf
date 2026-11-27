import { createServer } from 'http';
import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { socketService } from './socket.service.js';
import { registerSocketEvents } from './socket.routes.js';
import { serveDebugRequest } from './debug/http.js';
import { logEvent } from './debug/log.js';

// Extracted from index.ts so tests can start a real server on an ephemeral port.
// index.ts stays a thin script; everything that decides behaviour lives here.

export interface GameServerHandle {
    io: Server;
    httpServer: HttpServer;
    port: number;
    url: string;
    close: () => Promise<void>;
}

export async function startGameServer(port: number = 0): Promise<GameServerHandle> {
    const origins = process.env.ORIGIN === undefined ? [] : process.env.ORIGIN.split(' ');

    const httpServer = createServer((req, res) => {
        // Token-gated and off by default; returns false for anything that is not /debug.
        if (serveDebugRequest(req, res)) return;
        if (req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('Werwolf Backend is running (with WebSockets)!');
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    const io = new Server(httpServer, {
        cors: {
            origin: origins.length > 0 ? origins : "http://localhost:5173",
            methods: ["GET", "POST"]
        },
        // Detection speed for a phone that walked out of Wi-Fi range. The defaults
        // (25s interval + 20s timeout) leave a player staring at a frozen screen for up
        // to ~45s before the client even tries to reconnect.
        pingInterval: 10_000,
        pingTimeout: 10_000
    });

    // A rejected upgrade (wrong origin, proxy problem) is otherwise invisible: the phones
    // just never connect. Log the engine-level reason once, not per client.
    io.engine.on('connection_error', (error) => {
        logEvent('warn', 'socket.connection_error', {
            code: error.code,
            message: error.message,
            context: error.context,
        });
    });

    socketService.init(io);
    registerSocketEvents(io);

    await new Promise<void>((resolve) => httpServer.listen(port, resolve));

    const address = httpServer.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;

    return {
        io,
        httpServer,
        port: actualPort,
        url: `http://localhost:${actualPort}`,
        close: async () => {
            io.removeAllListeners();
            await new Promise<void>((resolve) => io.close(() => resolve()));
        }
    };
}
