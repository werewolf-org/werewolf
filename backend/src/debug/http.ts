import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { RUN_ID } from './log.js';
import { journal, renderDumpText } from './journal.js';

// Token-gated debugging endpoints, mounted on the same http server as socket.io.
//
// The dumps reveal every role, every ballot and every night action: that is the point.
// They are therefore OFF unless DEBUG_TOKEN is set on the server, and every request
// needs the token. A deployed instance without the env var answers 404, exactly like an
// unknown path, so nothing advertises that the feature exists.

const MAX_GAME_ID = 12;

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function tokenMatches(provided: string, expected: string): boolean {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

function providedToken(req: IncomingMessage, url: URL): string {
    const query = url.searchParams.get('token');
    if (query) return query;

    const header = req.headers['x-debug-token'];
    if (typeof header === 'string' && header.length > 0) return header;

    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length);
    return '';
}

function send(res: ServerResponse, status: number, body: string, contentType: string, downloadName?: string): void {
    const headers: Record<string, string> = {
        'content-type': contentType,
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
    };
    if (downloadName) headers['content-disposition'] = `attachment; filename="${downloadName}"`;
    res.writeHead(status, headers);
    res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    send(res, status, `${JSON.stringify(body, null, 2)}\n`, 'application/json; charset=utf-8');
}

function landingPage(url: URL, games: ReturnType<typeof journal.list>): string {
    const token = url.searchParams.get('token') ?? '';
    const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : '';
    const rows = games.length === 0
        ? '<tr><td colspan="5">No games in memory. A restart or a redeploy clears the journal; the stdout log still has every action.</td></tr>'
        : games.map((game) => {
            const textHref = `/debug/game/${encodeURIComponent(game.gameId)}?format=text${token ? `&token=${encodeURIComponent(token)}` : ''}`;
            const jsonHref = `/debug/game/${encodeURIComponent(game.gameId)}?format=json${token ? `&token=${encodeURIComponent(token)}` : ''}`;
            return `<tr>
                <td><a href="${escapeHtml(textHref)}">${escapeHtml(game.gameId)}</a></td>
                <td>${escapeHtml(game.phase ?? '-')}</td>
                <td>${game.round ?? '-'}</td>
                <td>${game.alive ?? '-'}/${game.players ?? '-'}</td>
                <td>${escapeHtml(game.lastEventAt ?? '-')}</td>
                <td>${game.events}${game.dropped > 0 ? ` (+${game.dropped} dropped)` : ''}</td>
                <td><a href="${escapeHtml(textHref)}">text</a> · <a href="${escapeHtml(jsonHref)}">json</a></td>
            </tr>`;
        }).join('');

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Werwolf debug</title>
<style>
 body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#111;color:#ddd;margin:2rem;line-height:1.5}
 a{color:#8fd3ff} table{border-collapse:collapse;width:100%} th,td{text-align:left;padding:.35rem .6rem;border-bottom:1px solid #333}
 h1{font-size:1.1rem} .warn{color:#ffb86b} .muted{color:#777}
</style></head>
<body>
<h1>Werwolf debug</h1>
<p class="muted">run ${escapeHtml(RUN_ID)} · ${games.length} game(s) in memory · node ${escapeHtml(process.version)} · uptime ${Math.round(process.uptime())}s</p>
<p class="warn">These dumps reveal every role, ballot and night action. Do not open this page in front of players.</p>
<table>
<thead><tr><th>game</th><th>phase</th><th>round</th><th>alive</th><th>last event</th><th>events</th><th></th></tr></thead>
<tbody>${rows}</tbody>
</table>
<p class="muted">Each game: <code>/debug/game/ID?format=text&amp;token=...</code> for a transcript, <code>format=json</code> for everything.
Add <code>&amp;since=SEQ</code> to fetch only what happened after a previous dump, and <code>&amp;download=1</code> to save it.</p>
<p class="muted"><a href="/debug/games${escapeHtml(tokenQuery)}">machine-readable game list</a></p>
</body></html>`;
}

function parseSince(url: URL): number | null | 'invalid' {
    const raw = url.searchParams.get('since');
    if (raw === null || raw === '') return null;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) return 'invalid';
    return parsed;
}

/**
 * Returns true when this module answered the request. Anything outside /debug is left
 * untouched for the normal server handler.
 */
export function serveDebugRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (path !== '/debug' && !path.startsWith('/debug/')) return false;

    // Fail closed. Without the env var this path behaves like any other 404, so a deploy
    // that forgot the token does not expose the role table.
    const expected = process.env.DEBUG_TOKEN?.trim();
    if (!expected) {
        send(res, 404, 'Not found\n', 'text/plain; charset=utf-8');
        return true;
    }

    if (req.method !== 'GET') {
        send(res, 405, 'Only GET is supported\n', 'text/plain; charset=utf-8');
        return true;
    }

    if (!tokenMatches(providedToken(req, url), expected)) {
        send(res, 401, 'Missing or wrong debug token\n', 'text/plain; charset=utf-8');
        return true;
    }

    if (path === '/debug' || path === '/debug/') {
        send(res, 200, landingPage(url, journal.list()), 'text/html; charset=utf-8');
        return true;
    }

    if (path === '/debug/games') {
        sendJson(res, 200, {
            run: RUN_ID,
            capturedAt: new Date().toISOString(),
            games: journal.list(),
        });
        return true;
    }

    const gameMatch = /^\/debug\/game\/([^/]+)\/?$/.exec(path);
    if (!gameMatch) {
        sendJson(res, 404, { error: 'Unknown debug endpoint' });
        return true;
    }

    const gameId = decodeURIComponent(gameMatch[1] ?? '').toUpperCase();
    if (!new RegExp(`^[A-Z0-9]{1,${MAX_GAME_ID}}$`).test(gameId)) {
        sendJson(res, 400, { error: 'Invalid game id' });
        return true;
    }

    const since = parseSince(url);
    if (since === 'invalid') {
        sendJson(res, 400, { error: 'since must be a non-negative integer sequence number' });
        return true;
    }

    const dump = journal.dump(gameId, since);
    if (!dump) {
        sendJson(res, 404, {
            error: `Game ${gameId} is not in the in-memory journal`,
            hint: 'The journal only covers the current process. After a restart use the stdout log, which contains every action and rejection.',
        });
        return true;
    }

    const format = (url.searchParams.get('format') ?? 'text').toLowerCase();
    if (format === 'json') {
        const body = `${JSON.stringify(dump, null, 2)}\n`;
        if (url.searchParams.get('download') === '1') {
            send(res, 200, body, 'application/json; charset=utf-8', `werwolf-${gameId}.json`);
        } else {
            send(res, 200, body, 'application/json; charset=utf-8');
        }
        return true;
    }

    if (format === 'text' || format === 'txt' || format === 'plain') {
        const body = `${renderDumpText(dump, since)}\n`;
        if (url.searchParams.get('download') === '1') {
            send(res, 200, body, 'text/plain; charset=utf-8', `werwolf-${gameId}.txt`);
        } else {
            send(res, 200, body, 'text/plain; charset=utf-8');
        }
        return true;
    }

    sendJson(res, 400, { error: `Unknown format '${format}'. Use text or json.` });
    return true;
}
