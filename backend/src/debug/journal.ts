import { RUN_ID, logEvent } from './log.js';
import type { Game, NightAction } from '../models.js';

// The black box: a bounded, per-game, in-memory journal of everything that happened.
//
// It exists because Render only keeps stdout. stdout answers "which action was rejected
// with which error", but not "what did the table look like at that moment". The journal
// carries the full game state after every mutation (a 10 player game is ~2 KB, a whole
// game is a few hundred events), so one dump is a self-contained forensic record.
//
// Bounded on purpose: a running instance must not grow without limit. When the budget is
// exceeded the oldest entries are dropped and counted, never silently.

function envInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const MAX_EVENTS = envInt('DEBUG_JOURNAL_MAX_EVENTS', 500);
const MAX_BYTES = envInt('DEBUG_JOURNAL_MAX_BYTES', 2_000_000);
const TTL_MS = envInt('DEBUG_JOURNAL_TTL_HOURS', 24) * 60 * 60 * 1000;

export type JournalKind = 'action' | 'state' | 'socket' | 'note';

export interface JournalEvent {
    seq: number;
    at: string;
    atMs: number;
    kind: JournalKind;
    /** Socket event name ('vote'), lifecycle name ('disconnect') or note ('game.created'). */
    name: string;
    socketId: string | null;
    playerUUID: string | null;
    /** null while the handler is still running (a dump can catch one in flight). */
    ok: boolean | null;
    ms: number | null;
    error: string | null;
    payload: unknown;
    /** Full game state after the mutation. Only for kind === 'state'. */
    state: Game | null;
}

export interface GameSummary {
    gameId: string;
    events: number;
    dropped: number;
    lastEventAt: string | null;
    phase: string | null;
    round: number | null;
    players: number | null;
    alive: number | null;
}

export interface GameDump extends GameSummary {
    run: string;
    capturedAt: string;
    createdAt: number | null;
    process: { pid: number; node: string; uptimeSec: number; env: string };
    state: Game | null;
    journal: JournalEvent[];
}

export interface ActionHandle {
    readonly seq: number;
    finish(ok: boolean, ms: number, error?: string): void;
}

function cloneGame(game: Game): Game {
    // JSON round trip, not structuredClone: the game is plain data and this is the exact
    // shape that goes over the wire, so a field that cannot serialise shows up here too.
    return JSON.parse(JSON.stringify(game)) as Game;
}

function playerName(game: Game | null, playerUUID: string | null | false | undefined): string {
    if (playerUUID === false) return 'abstain';
    if (playerUUID === null || playerUUID === undefined) return 'nobody';
    const player = game?.players.find((p) => p.playerUUID === playerUUID);
    return player?.displayName || `#${playerUUID.slice(0, 6)}`;
}

function describeNightAction(action: NightAction | null, game: Game | null): string {
    if (!action) return 'none';
    const bits: string[] = [];
    if ('targetUUID' in action) bits.push(`target ${playerName(game, action.targetUUID)}`);
    if (action.revealUUID) {
        bits.push(`reveal ${playerName(game, action.revealUUID)}${action.revealedRole ? ` (${action.revealedRole})` : ''}`);
    }
    if ('heal' in action) bits.push(`heal=${String(action.heal)}`);
    if ('killUUID' in action) bits.push(`poison ${playerName(game, action.killUUID)}`);
    if (action.firstPlayerUUID) bits.push(`lover A ${playerName(game, action.firstPlayerUUID)}`);
    if (action.secondPlayerUUID) bits.push(`lover B ${playerName(game, action.secondPlayerUUID)}`);
    if (action.sleepoverUUID) bits.push(`sleepover ${playerName(game, action.sleepoverUUID)}`);
    return bits.length > 0 ? bits.join(', ') : 'empty';
}

// Human-readable changes between two states. Explicit fields rather than a generic deep
// diff: the interesting changes are exactly the game's own vocabulary (a ballot, a death,
// a potion), and a generic diff of a nested object is unreadable in a transcript.
export function describeChanges(previous: Game | null, next: Game): string[] {
    if (!previous) {
        return [`first record: ${next.players.length} players, ${next.phase}, round ${next.round}`];
    }
    const changes: string[] = [];

    if (previous.phase !== next.phase) changes.push(`phase ${previous.phase} -> ${next.phase}`);
    if (previous.round !== next.round) changes.push(`round ${previous.round} -> ${next.round}`);
    if (previous.activeNightRole !== next.activeNightRole) {
        changes.push(`active ${previous.activeNightRole ?? 'none'} -> ${next.activeNightRole ?? 'none'}`);
    }
    if (previous.sheriffUUID !== next.sheriffUUID) {
        changes.push(`sheriff ${playerName(previous, previous.sheriffUUID)} -> ${playerName(next, next.sheriffUUID)}`);
    }
    if (previous.lynchDone !== next.lynchDone) changes.push(`lynchDone=${String(next.lynchDone)}`);
    if (previous.sheriffElectionDone !== next.sheriffElectionDone) {
        changes.push(`sheriffElectionDone=${String(next.sheriffElectionDone)}`);
    }
    if (previous.winningTeam !== next.winningTeam) {
        changes.push(`winningTeam ${previous.winningTeam || 'none'} -> ${next.winningTeam || 'none'}`);
    }
    if (previous.lastVotedOutUUID !== next.lastVotedOutUUID) {
        changes.push(`votedOut ${playerName(next, next.lastVotedOutUUID)}`);
    }

    for (const player of next.players) {
        const before = previous.players.find((p) => p.playerUUID === player.playerUUID);
        if (!before) {
            changes.push(`${player.displayName || 'A player'} joined`);
            continue;
        }
        if (before.displayName !== player.displayName) {
            changes.push(`${before.displayName} renamed to ${player.displayName}`);
        }
        if (before.isAlive && !player.isAlive) {
            changes.push(`${player.displayName} died (${player.role ?? 'unknown'})`);
        }
        if (before.isAlive !== player.isAlive && player.isAlive) {
            changes.push(`${player.displayName} is alive again`);
        }
        if (before.role !== player.role) {
            changes.push(`${player.displayName} role ${before.role ?? '-'} -> ${player.role ?? '-'}`);
        }
        if (before.nominationUUID !== player.nominationUUID) {
            changes.push(`${player.displayName} nominated ${playerName(next, player.nominationUUID)}`);
        }
        if (before.voteTargetUUID !== player.voteTargetUUID) {
            changes.push(`${player.displayName} voted ${playerName(next, player.voteTargetUUID)}`);
        }
        if (before.readyForNight !== player.readyForNight) {
            changes.push(`${player.displayName} ready=${String(player.readyForNight)}`);
        }
        if (before.usedHealingPotion !== player.usedHealingPotion) {
            changes.push(`${player.displayName} healingPotion=${String(player.usedHealingPotion)}`);
        }
        if (before.usedKillingPotion !== player.usedKillingPotion) {
            changes.push(`${player.displayName} killingPotion=${String(player.usedKillingPotion)}`);
        }
        if (before.lovePartner !== player.lovePartner) {
            changes.push(`${player.displayName} loves ${playerName(next, player.lovePartner)}`);
        }
        if (before.lovePartnerConfirmed !== player.lovePartnerConfirmed) {
            changes.push(`${player.displayName} loveConfirmed=${String(player.lovePartnerConfirmed)}`);
        }
        const beforeNight = JSON.stringify(before.nightAction);
        const afterNight = JSON.stringify(player.nightAction);
        if (beforeNight !== afterNight) {
            changes.push(`${player.displayName} night ${describeNightAction(player.nightAction, next)}`);
        }
    }

    return changes;
}

export class GameJournal {
    readonly gameId: string;
    private events: JournalEvent[] = [];
    private nextSeq = 0;
    private bytes = 0;
    private dropped = 0;
    private lastStateJson: string | null = null;
    private lastStateGame: Game | null = null;
    private readonly maxEvents: number;
    private readonly maxBytes: number;
    lastEventAt: number = Date.now();

    constructor(gameId: string, limits: { maxEvents?: number; maxBytes?: number } = {}) {
        this.gameId = gameId;
        this.maxEvents = limits.maxEvents ?? MAX_EVENTS;
        this.maxBytes = limits.maxBytes ?? MAX_BYTES;
    }

    private append(event: Omit<JournalEvent, 'seq' | 'at' | 'atMs'>): JournalEvent {
        const entry: JournalEvent = {
            ...event,
            seq: this.nextSeq++,
            at: new Date().toISOString(),
            atMs: Date.now(),
        };
        this.events.push(entry);
        this.lastEventAt = entry.atMs;
        this.bytes += Buffer.byteLength(JSON.stringify(entry));

        // Always keep at least the entry we just added, even if it alone exceeds the budget.
        while (this.events.length > 1 && (this.events.length > this.maxEvents || this.bytes > this.maxBytes)) {
            const removed = this.events.shift();
            if (!removed) break;
            this.bytes -= Buffer.byteLength(JSON.stringify(removed));
            this.dropped += 1;
        }
        return entry;
    }

    note(name: string, state: Game | null = null, meta: Record<string, unknown> = {}): JournalEvent {
        // A lifecycle note can be the first thing a game ever records (created, never
        // joined). Keeping its state means the very first failure still has a table to show.
        if (state) {
            this.lastStateGame = cloneGame(state);
            this.lastStateJson = JSON.stringify(state);
        }
        return this.append({
            kind: 'note',
            name,
            socketId: null,
            playerUUID: null,
            ok: true,
            ms: null,
            error: null,
            payload: meta,
            state: state ? cloneGame(state) : null,
        });
    }

    recordState(game: Game): JournalEvent | null {
        const json = JSON.stringify(game);
        // A broadcast that changed nothing is noise; the action line already says an
        // action happened, and a transcript full of identical states hides the real ones.
        if (json === this.lastStateJson) return null;

        const previous = this.lastStateGame;
        this.lastStateJson = json;
        this.lastStateGame = cloneGame(game);

        const entry = this.append({
            kind: 'state',
            name: 'state',
            socketId: null,
            playerUUID: null,
            ok: true,
            ms: null,
            error: null,
            payload: { changes: describeChanges(previous, game) },
            state: this.lastStateGame,
        });

        const dead = game.players.filter((p) => !p.isAlive).map((p) => p.displayName);
        logEvent('info', 'state', {
            game: game.gameId,
            seq: entry.seq,
            phase: game.phase,
            round: game.round,
            active: game.activeNightRole,
            alive: game.players.filter((p) => p.isAlive).length,
            dead,
            sheriff: playerName(game, game.sheriffUUID),
            winningTeam: game.winningTeam || null,
            changes: (entry.payload as { changes: string[] }).changes,
        });
        return entry;
    }

    recordSocket(name: string, socketId: string, playerUUID: string | null): JournalEvent {
        const entry = this.append({
            kind: 'socket',
            name,
            socketId,
            playerUUID,
            ok: true,
            ms: null,
            error: null,
            payload: null,
            state: null,
        });
        logEvent('info', 'socket', { game: this.gameId, seq: entry.seq, socket: socketId, player: playerUUID, name });
        return entry;
    }

    beginAction(name: string, socketId: string, playerUUID: string | null, payload: unknown): ActionHandle {
        const entry = this.append({
            kind: 'action',
            name,
            socketId,
            playerUUID,
            ok: null,
            ms: null,
            error: null,
            payload,
            state: null,
        });

        // Logged before the handler runs. If the handler crashes the process, this line is
        // already in Render's log: the last thing we did is never a mystery.
        logEvent('info', 'action', {
            game: this.gameId,
            seq: entry.seq,
            name,
            socket: socketId,
            player: playerUUID,
            phase: this.lastStateGame?.phase ?? null,
            round: this.lastStateGame?.round ?? null,
            payload,
        });

        return {
            seq: entry.seq,
            finish: (ok: boolean, ms: number, error?: string) => {
                entry.ok = ok;
                entry.ms = ms;
                entry.error = error ?? null;
                if (!ok) {
                    logEvent('warn', 'rejected', {
                        game: this.gameId,
                        seq: entry.seq,
                        name,
                        socket: socketId,
                        player: playerUUID,
                        error: entry.error,
                        ms,
                    });
                }
            },
        };
    }

    get phase(): string | null {
        return this.lastStateGame?.phase ?? null;
    }

    get round(): number | null {
        return this.lastStateGame?.round ?? null;
    }

    get state(): Game | null {
        return this.lastStateGame;
    }

    get stored(): number {
        return this.events.length;
    }

    summary(): GameSummary {
        const state = this.lastStateGame;
        return {
            gameId: this.gameId,
            events: this.events.length,
            dropped: this.dropped,
            lastEventAt: this.lastEventAt ? new Date(this.lastEventAt).toISOString() : null,
            phase: state?.phase ?? null,
            round: state?.round ?? null,
            players: state?.players.length ?? null,
            alive: state ? state.players.filter((p) => p.isAlive).length : null,
        };
    }

    dump(): GameDump {
        return {
            ...this.summary(),
            run: RUN_ID,
            capturedAt: new Date().toISOString(),
            createdAt: this.lastStateGame?.createdAt ?? null,
            process: {
                pid: process.pid,
                node: process.version,
                uptimeSec: Math.round(process.uptime()),
                env: process.env.NODE_ENV ?? 'development',
            },
            state: this.lastStateGame,
            journal: [...this.events],
        };
    }

    isStale(now: number, ttlMs: number = TTL_MS): boolean {
        return now - this.lastEventAt > ttlMs;
    }

    eventsSince(since: number | null): JournalEvent[] {
        if (since === null) return [...this.events];
        return this.events.filter((event) => event.seq > since);
    }
}

class JournalRegistry {
    private journals = new Map<string, GameJournal>();

    getOrCreate(gameId: string): GameJournal {
        let journal = this.journals.get(gameId);
        if (!journal) {
            journal = new GameJournal(gameId);
            this.journals.set(gameId, journal);
        }
        return journal;
    }

    get(gameId: string): GameJournal | undefined {
        return this.journals.get(gameId);
    }

    noteGameCreated(game: Game): GameJournal {
        const journal = this.getOrCreate(game.gameId);
        journal.note('game.created', game, { managerUUID: game.managerUUID });
        return journal;
    }

    recordState(game: Game): void {
        this.getOrCreate(game.gameId).recordState(game);
    }

    recordSocket(gameId: string, name: string, socketId: string, playerUUID: string | null): void {
        this.getOrCreate(gameId).recordSocket(name, socketId, playerUUID);
    }

    beginAction(gameId: string, name: string, socketId: string, playerUUID: string | null, payload: unknown): ActionHandle {
        return this.getOrCreate(gameId).beginAction(name, socketId, playerUUID, payload);
    }

    prune(now: number = Date.now(), ttlMs: number = TTL_MS): void {
        for (const [gameId, journal] of this.journals) {
            if (journal.isStale(now, ttlMs)) {
                logEvent('info', 'journal.pruned', { game: gameId, events: journal.stored });
                this.journals.delete(gameId);
            }
        }
    }

    list(): GameSummary[] {
        return [...this.journals.values()]
            .map((journal) => journal.summary())
            .sort((a, b) => (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? ''));
    }

    dump(gameId: string, since: number | null = null): GameDump | null {
        const journal = this.journals.get(gameId);
        if (!journal) return null;
        const dump = journal.dump();
        dump.journal = journal.eventsSince(since);
        return dump;
    }

    /** Every live journal, used by the fatal path and by SIGTERM. */
    dumpAll(limitBytes: number): { gameId: string; text: string }[] {
        const out: { gameId: string; text: string }[] = [];
        let budget = limitBytes;
        for (const journal of this.journals.values()) {
            if (budget <= 0) break;
            const text = renderDumpText(journal.dump());
            const bytes = Buffer.byteLength(text);
            if (bytes > budget) {
                // Cut on a line boundary and say so; a silently half-written transcript
                // would look like the game ended there.
                const cut = Buffer.from(text).subarray(0, Math.max(0, budget)).toString('utf8');
                const lastLine = cut.lastIndexOf('\n');
                const body = `${lastLine > 0 ? cut.slice(0, lastLine) : cut}\n[truncated: dump exceeded the ${limitBytes} byte shutdown budget]\n`;
                out.push({ gameId: journal.gameId, text: body });
                break;
            }
            out.push({ gameId: journal.gameId, text });
            budget -= bytes;
        }
        return out;
    }

    reset(): void {
        this.journals.clear();
    }
}

export const journal = new JournalRegistry();

// --- text rendering: what a human pastes into a chat -------------------------------

function pad(value: string, width: number): string {
    return value.length >= width ? `${value} ` : value.padEnd(width);
}

function clockOf(iso: string): string {
    // ISO is UTC. The header says so; a fixed-width slice is enough for a transcript.
    return iso.slice(11, 23);
}

function ref(uuid: string | null | false | undefined, names: Map<string, string>): string {
    if (uuid === false) return 'abstain';
    if (uuid === null || uuid === undefined) return 'nobody';
    return names.get(uuid) || `#${uuid.slice(0, 6)}`;
}

function nameMapOf(game: Game | null): Map<string, string> {
    const names = new Map<string, string>();
    for (const player of game?.players ?? []) {
        if (player.playerUUID) names.set(player.playerUUID, player.displayName || `#${player.playerUUID.slice(0, 6)}`);
    }
    return names;
}

function describePayload(payload: unknown, names: Map<string, string>): string {
    if (payload === null || typeof payload !== 'object') return '';
    const parts: string[] = [];
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
        if (key === 'gameId') continue;
        const label = key.replace(/UUID$/, '');
        if (typeof value === 'string' && /UUID$/.test(key)) {
            parts.push(`${label} ${ref(value, names)}`);
        } else if (value === false && /UUID$/.test(key)) {
            parts.push(`${label} abstain`);
        } else if (value === null) {
            parts.push(`${label} none`);
        } else if (typeof value === 'object') {
            parts.push(`${label} ${JSON.stringify(value)}`);
        } else {
            parts.push(`${label}=${String(value)}`);
        }
    }
    return parts.join(', ');
}

function formatRoles(game: Game | null): string[] {
    if (!game) return ['  (no state recorded)'];
    const lines = game.players.map((player) => {
        const role = player.role ?? '-';
        const state = player.isAlive ? '' : '  dead';
        const sheriff = player.playerUUID && player.playerUUID === game.sheriffUUID ? '  sheriff' : '';
        const name = player.displayName || `(unnamed ${(player.playerUUID ?? '?').slice(0, 6)})`;
        return `  ${pad(name, 20)} ${pad(role, 12)}${state}${sheriff}`;
    });
    return lines.length > 0 ? lines : ['  (no players)'];
}

function formatTable(game: Game | null): string[] {
    if (!game) return ['  (no state recorded)'];
    const alive = game.players.filter((p) => p.isAlive);
    const dead = game.players.filter((p) => !p.isAlive);
    return [
        `  phase      ${game.phase}`,
        `  round      ${game.round}`,
        `  alive      ${alive.length}/${game.players.length}${dead.length > 0 ? ` (dead: ${dead.map((p) => p.displayName || '(unnamed)').join(', ')})` : ''}`,
        `  sheriff    ${playerName(game, game.sheriffUUID)}`,
        `  active     ${game.activeNightRole ?? '-'}`,
        `  winning    ${game.winningTeam || '-'}`,
    ];
}

export function renderDumpText(dump: GameDump, since: number | null = null): string {
    const game = dump.state;
    const names = nameMapOf(game);
    const lines: string[] = [];

    lines.push('=== WEREWOLF DEBUG DUMP ===');
    lines.push(`run       ${dump.run}`);
    lines.push(`game      ${dump.gameId}`);
    lines.push(`created   ${dump.createdAt ? new Date(dump.createdAt).toISOString() : 'unknown'}`);
    lines.push(`captured  ${dump.capturedAt} (all times UTC)`);
    lines.push(`server    node ${dump.process.node} · pid ${dump.process.pid} · uptime ${dump.process.uptimeSec}s · env ${dump.process.env}`);
    lines.push('');
    lines.push('-- roles (current) --');
    lines.push(...formatRoles(game));
    lines.push('');
    lines.push('-- table (current) --');
    lines.push(...formatTable(game));
    lines.push('');
    const total = dump.journal.length;
    const sinceNote = since === null ? '' : ` after seq ${since}`;
    const dropNote = dump.dropped > 0 ? ` · ${dump.dropped} older events dropped` : '';
    lines.push(`-- transcript (${total} events${sinceNote}${dropNote}) --`);

    for (const event of dump.journal) {
        if (event.state) {
            // Update names as the transcript walks forward, so an old action shows the
            // name the player had at that point, not the name they have now.
            for (const player of event.state.players) {
                if (player.playerUUID) names.set(player.playerUUID, player.displayName || `#${player.playerUUID.slice(0, 6)}`);
            }
        }
        const time = clockOf(event.at);
        const seq = `#${String(event.seq).padStart(3, '0')}`;

        if (event.kind === 'action') {
            const who = event.playerUUID ? ref(event.playerUUID, names) : '?';
            const payload = describePayload(event.payload, names);
            let result = '';
            if (event.ok === false) result = `  REJECTED: ${event.error ?? 'unknown error'}`;
            else if (event.ok === null) result = '  [still running]';
            if (event.ms !== null && event.ok !== false) result += `  ${event.ms}ms`;
            lines.push(`  ${time}  ${seq}  ${pad(event.name, 16)} ${pad(who, 20)} ${payload}${result}`);
            continue;
        }

        if (event.kind === 'state') {
            const changes = (event.payload as { changes?: string[] } | null)?.changes ?? [];
            const text = changes.length > 0 ? changes.join(' · ') : 'no visible change';
            lines.push(`  ${time}  ${seq}  ${pad('state', 16)} ${text}`);
            continue;
        }

        if (event.kind === 'socket') {
            const who = event.playerUUID ? ref(event.playerUUID, names) : (event.socketId ? `socket ${event.socketId}` : '?');
            lines.push(`  ${time}  ${seq}  ${pad(event.name, 16)} ${who}`);
            continue;
        }

        lines.push(`  ${time}  ${seq}  ${pad(event.name, 16)} ${describePayload(event.payload, names)}`);
    }

    if (dump.journal.length === 0) lines.push('  (no events in this window)');
    lines.push('');
    lines.push('Note: the current role table reveals secrets by design. Keep this dump private.');
    return lines.join('\n');
}
