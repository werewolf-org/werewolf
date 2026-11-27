import * as dotenv from 'dotenv';
import { startGameServer } from './server.js';
import { installDebugHooks } from './debug/install.js';
import { logEvent } from './debug/log.js';

if (process.env.NODE_ENV !== "production") dotenv.config();

// Installed before the server starts: a crash during boot is exactly the case where the
// log matters most. Kept out of server.ts so the test harness does not inherit handlers.
installDebugHooks();

const PORT = Number(process.env.PORT ?? 3000);

const server = await startGameServer(PORT);
logEvent("info", "server.started", { url: server.url });
