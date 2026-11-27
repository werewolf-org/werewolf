import { journal } from './journal.js';
import { RUN_ID, logEvent, serializeError, writeLogSync } from './log.js';

// Process-level net. The dump can be a few hundred KB, so it is flushed through the
// stdout stream and the process exits in the write callback. A synchronous write of that
// size to a non-blocking pipe (which is what Render gives us) can fail with EAGAIN and
// lose exactly the record this exists for. The small one-line summaries still use
// writeSync: they fit and must not depend on the event loop.
//
// Installed from index.ts only, never from server.ts, so tests do not inherit process
// handlers they did not ask for.

const MAX_DUMP_BYTES = 512_000;

function buildDumpText(reason: string): string {
    const dumps = journal.dumpAll(MAX_DUMP_BYTES);
    const header = `[werwolf-dump] ${JSON.stringify({
        run: RUN_ID,
        kind: reason,
        at: new Date().toISOString(),
        games: dumps.map((dump) => dump.gameId),
    })}\n`;

    const blocks = dumps.map(({ gameId, text }) => {
        const prefixed = text
            .split('\n')
            .map((line) => `[werwolf-dump] ${line}`)
            .join('\n');
        return { gameId, body: `${prefixed}\n`, bytes: Buffer.byteLength(prefixed) };
    });

    writeLogSync('warn', 'fatal.dump_start', {
        reason,
        games: blocks.map((block) => block.gameId),
        bytes: blocks.reduce((sum, block) => sum + block.bytes, 0),
    });

    return header + blocks.map((block) => block.body).join('');
}

function flushAndExit(text: string, code: number): void {
    let exited = false;
    const done = () => {
        if (exited) return;
        exited = true;
        process.exit(code);
    };

    try {
        process.stdout.write(text, done);
    } catch {
        done();
        return;
    }

    // Never hang a deploy on a backed-up pipe. Two seconds is far more than a local
    // drain needs; if stdout is truly wedged, the per-action lines are already written.
    setTimeout(done, 2_000);
}

let handlingFatal = false;

function handleFatal(event: string, error: unknown): void {
    if (handlingFatal) return;
    handlingFatal = true;

    const serialized = serializeError(error);
    writeLogSync('error', event, {
        ...serialized,
        games: journal.list().map((game) => game.gameId),
    });
    flushAndExit(buildDumpText(event), 1);
}

export function installDebugHooks(): void {
    if (process.env.DEBUG_HOOKS === '0') return;

    process.on('uncaughtException', (error) => handleFatal('uncaughtException', error));
    process.on('unhandledRejection', (reason) => handleFatal('unhandledRejection', reason));

    // Render sends SIGTERM on every deploy and manual restart. Without this the last
    // in-memory state of every running game disappears silently; with it, the log keeps a
    // complete transcript of each game as it stood at shutdown.
    const shutdown = (signal: string) => {
        if (handlingFatal) return;
        handlingFatal = true;
        writeLogSync('warn', 'shutdown', { signal, games: journal.list().map((game) => game.gameId) });
        flushAndExit(buildDumpText(signal), 0);
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));

    const token = process.env.DEBUG_TOKEN?.trim();
    if (!token) {
        logEvent('info', 'debug.http_disabled', { hint: 'set DEBUG_TOKEN to enable /debug' });
    } else if (token.length < 16) {
        logEvent('warn', 'debug.weak_token', { length: token.length, hint: 'use at least 16 characters' });
    }

    logEvent('info', 'debug.hooks', { run: RUN_ID });
}
