import { getState, type LocalAppState } from './store';

// Client-side black box. The server journal records what the backend did; this records
// what one phone actually received, which is the other half of "the screen is wrong".
//
// It must survive the failure it is meant to explain, so it stores plain data, never
// touches the DOM to collect it, and keeps working when the socket is down.

export interface ClientDebugEvent {
    at: string;
    kind: string;
    data: unknown;
}

const MAX_EVENTS = 150;
const MAX_BYTES = 180_000;

const events: ClientDebugEvent[] = [];
let bytes = 0;
let installed = false;

function sizeOf(value: unknown): number {
    try {
        return JSON.stringify(value)?.length ?? 0;
    } catch {
        return 0;
    }
}

/** Record one thing that happened on this phone. Never throws: a broken debug trail must
 *  not break the game it is observing. */
export function recordClientEvent(kind: string, data: unknown): void {
    try {
        const event: ClientDebugEvent = { at: new Date().toISOString(), kind, data };
        events.push(event);
        bytes += sizeOf(event);
        while (events.length > 1 && (events.length > MAX_EVENTS || bytes > MAX_BYTES)) {
            const removed = events.shift();
            if (!removed) break;
            bytes -= sizeOf(removed);
        }
    } catch {
        // Ignored on purpose.
    }
}

export function installClientDebugHooks(): void {
    if (installed) return;
    installed = true;

    window.addEventListener('error', (event) => {
        recordClientEvent('window.error', {
            message: event.message,
            source: event.filename,
            line: event.lineno,
            column: event.colno,
            stack: event.error instanceof Error ? event.error.stack ?? null : null,
        });
    });

    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason as { message?: string; stack?: string } | undefined;
        recordClientEvent('window.unhandledrejection', {
            reason: reason?.message ?? String(event.reason),
            stack: reason?.stack ?? null,
        });
    });
}

export function buildDebugReport(): string {
    const state: LocalAppState = { ...getState() };
    const report = {
        kind: 'werwolf-client-debug',
        capturedAt: new Date().toISOString(),
        warning: 'Contains private role and ballot data for this phone. Keep it private.',
        url: window.location.href,
        userAgent: navigator.userAgent,
        visibility: document.visibilityState,
        online: navigator.onLine,
        gameId: state.gameId,
        playerUUID: state.playerUUID,
        phase: state.phase,
        isManager: state.isManager,
        state,
        events,
    };

    try {
        return JSON.stringify(report, null, 2);
    } catch (error) {
        return JSON.stringify({
            kind: 'werwolf-client-debug',
            capturedAt: new Date().toISOString(),
            serialisationError: String(error),
            events,
        }, null, 2);
    }
}

function fallbackCopy(text: string): boolean {
    // Older iOS Safari refuses navigator.clipboard outside a user gesture chain, and a
    // rejected promise there would leave the GM with no way to hand over the report.
    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        document.body.appendChild(area);
        area.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(area);
        return copied;
    } catch {
        return false;
    }
}

export async function copyDebugReport(): Promise<boolean> {
    const text = buildDebugReport();
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            recordClientEvent('debug.report.copied', { bytes: text.length });
            return true;
        }
    } catch {
        // Fall through to the textarea path.
    }
    const copied = fallbackCopy(text);
    recordClientEvent('debug.report.copied', { bytes: text.length, fallback: true, copied });
    return copied;
}

/** Test hook: forget the buffer. */
