import { createServer } from 'http';
import { Server } from 'socket.io';
import * as dotenv from 'dotenv';
import { socketService } from './socket.service.js';
import { registerSocketEvents } from './socket.routes.js';

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

const io = new Server(httpServer, {
  cors: {
    origin: origins.length > 0 ? origins : "http://localhost:5173",
    methods: ["GET", "POST"]
  }
});

socketService.init(io);
registerSocketEvents(io);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
});
