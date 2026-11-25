import * as dotenv from 'dotenv';
import { startGameServer } from './server.js';

if (process.env.NODE_ENV !== "production") dotenv.config();

const PORT = Number(process.env.PORT ?? 3000);

const server = await startGameServer(PORT);
console.log(`Backend server running on ${server.url}`);
