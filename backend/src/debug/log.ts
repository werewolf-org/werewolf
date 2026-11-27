import { randomBytes } from 'node:crypto';
import { writeSync } from 'node:fs';

// One process = one run id. Render mixes the output of every deploy in one log stream,
// so without this a dump from today and a dump from the previous build look identical.
export const RUN_ID = randomBytes(4).toString('hex');

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogFields {
    [key: string]: unknown;
}

// A single log line must stay greppable and must not eat the whole log quota. Payloads
// are game actions (a few hundred bytes); only a runaway stack or a huge name can grow.
const MAX_LINE_BYTES = 16_384;

function safeStringify(value: unknown): string {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, current) => {
        if (typeof current === 'bigint') return current.toString();
        if (typeof current === 'object' && current !== null) {
            if (seen.has(current)) return '[circular]';
            seen.add(current);
        }
        return current;
    });
}

export function serializeError(error: unknown): { name: string; message: string; stack: string | null } {
    if (error instanceof Error) {
        return { name: error.name, message: error.message, stack: error.stack ?? null };
    }
    return { name: 'Error', message: String(error), stack: null };
}

/** Build the one-line JSON record. Exported so the fatal path can write it synchronously. */
export function buildLogRecord(level: LogLevel, event: string, fields: LogFields): Record<string, unknown> {
    return {
        ts: new Date().toISOString(),
        run: RUN_ID,
        level,
        event,
        ...fields,
    };
}

export function formatLogRecord(record: Record<string, unknown>): string {
    let line = `[werwolf] ${safeStringify(record)}`;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        // Keep the envelope so the event is still findable; drop only the heavy payload.
        const { payload, ...rest } = record as Record<string, unknown> & { payload?: unknown };
        const payloadBytes = payload === undefined ? 0 : Buffer.byteLength(safeStringify(payload));
        line = `[werwolf] ${safeStringify({ ...rest, payload: `[dropped: ${payloadBytes} bytes]` })}`;
    }
    return line;
}

/**
 * Write one structured line to stdout.
 *
 * stdout, not stderr, and not a file: Render aggregates it, keeps it past a crash, and
 * exposes it in the dashboard. A file inside the container would vanish with the
 * container, which is exactly when it is needed.
 */
export function logEvent(level: LogLevel, event: string, fields: LogFields = {}): void {
    process.stdout.write(`${formatLogRecord(buildLogRecord(level, event, fields))}\n`);
}

/** Synchronous write for the fatal path: async stdout may never flush before exit. */
export function writeLogSync(level: LogLevel, event: string, fields: LogFields = {}): void {
    const line = `${formatLogRecord(buildLogRecord(level, event, fields))}\n`;
    try {
        // writeSync on fd 1, not process.stdout.write: the latter is queued when stdout is
        // a pipe (which is what Render gives us) and the queue dies with the process.
        writeSync(1, line);
    } catch {
        // Nothing left to do.
    }
}
