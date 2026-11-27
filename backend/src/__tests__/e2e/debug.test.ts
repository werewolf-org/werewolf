import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { TestGame } from './harness.js';
import { journal } from '../../debug/journal.js';
import { GameStore } from '../../store/game.store.js';
import { Role } from '@shared/roles.js';

// The black box over the wire: a real server, real clients, a real rejection, then the
// dump fetched exactly like the operator would fetch it. The unit tests cover the journal
// and the HTTP routes separately; this proves they are wired to the live game.

const TOKEN = 'e2e-debug-token';

const FOUR_ONE_WOLF: Record<string, number> = {
    [Role.WEREWOLF]: 1,
    [Role.VILLAGER]: 3,
};

let game: TestGame | null = null;

beforeEach(() => {
    GameStore.getInstance().clear();
    journal.reset();
    process.env.DEBUG_TOKEN = TOKEN;
});

afterEach(async () => {
    await game?.close();
    game = null;
    delete process.env.DEBUG_TOKEN;
    journal.reset();
});

describe('debug dump', () => {
    it('serves the whole game, including the rejected action, after a real rejection', async () => {
        const t = await TestGame.create({ playerCount: 4 });
        game = t;
        await t.setupAndStart(FOUR_ONE_WOLF);

        // A non-manager tries a manager-only action. This is the kind of failure the
        // operator later has to explain: the phone says "not allowed", the log must say why.
        t.clients[1]!.socket.emit('closeJoining', { gameId: t.gameId });
        await expect.poll(() => t.clients[1]!.errors.length, { timeout: 5000 }).toBe(1);

        const response = await fetch(`${t.server.url}/debug/game/${t.gameId}?format=json&token=${TOKEN}`);
        expect(response.status).toBe(200);
        const dump = await response.json() as {
            gameId: string;
            state: { phase: string; players: { playerUUID: string; role: string | null }[] };
            journal: { seq: number; kind: string; name: string; ok: boolean | null; error: string | null }[];
        };

        expect(dump.gameId).toBe(t.gameId);
        expect(dump.state.phase).toBe('NIGHT');

        const rejection = dump.journal.find((entry) => entry.kind === 'action' && entry.name === 'closeJoining' && entry.ok === false);
        expect(rejection, 'the rejected action is in the journal').toBeDefined();
        expect(rejection!.ok).toBe(false);
        expect(rejection!.error).toContain('Only the game manager');

        // The role table is the current, complete deal: the one thing a live snapshot hides.
        const dealt = t.clients
            .map((client) => `${client.playerUUID}:${client.state!.role}`)
            .sort();
        const dumped = dump.state.players
            .map((player) => `${player.playerUUID}:${player.role}`)
            .sort();
        expect(dumped).toEqual(dealt);

        // Sequence numbers are strictly increasing, so an incremental pull is unambiguous.
        const sequences = dump.journal.map((entry) => entry.seq);
        expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
        expect(new Set(sequences).size).toBe(sequences.length);
    });

    it('renders the same game as a human-readable transcript', async () => {
        const t = await TestGame.create({ playerCount: 4 });
        game = t;
        await t.setupAndStart(FOUR_ONE_WOLF);

        t.clients[1]!.socket.emit('closeJoining', { gameId: t.gameId });
        await expect.poll(() => t.clients[1]!.errors.length, { timeout: 5000 }).toBe(1);

        const response = await fetch(`${t.server.url}/debug/game/${t.gameId}?format=text&token=${TOKEN}`);
        const text = await response.text();

        expect(text).toContain('=== WEREWOLF DEBUG DUMP ===');
        expect(text).toContain(`game      ${t.gameId}`);
        expect(text).toContain('closeJoining');
        expect(text).toContain('REJECTED: Only the game manager');
        expect(text).toContain('game.created');
        // The deal is spelled out: this is what makes a dump actionable without a database.
        expect(text).toContain('WEREWOLF');
    });

    it('keeps the dump private without the token', async () => {
        const t = await TestGame.create({ playerCount: 4 });
        game = t;
        await t.setupAndStart(FOUR_ONE_WOLF);

        expect((await fetch(`${t.server.url}/debug/game/${t.gameId}`)).status).toBe(401);
        expect((await fetch(`${t.server.url}/debug/game/${t.gameId}?token=wrong`)).status).toBe(401);
    });

    it('forgets the game when the process forgets it, and says so', async () => {
        const t = await TestGame.create({ playerCount: 4 });
        game = t;
        await t.setupAndStart(FOUR_ONE_WOLF);

        // A restart/redeploy clears the in-memory journal. The response must not pretend
        // the game never existed; it points at the surviving stdout log instead.
        journal.reset();
        const response = await fetch(`${t.server.url}/debug/game/${t.gameId}?format=json&token=${TOKEN}`);
        expect(response.status).toBe(404);
        const body = await response.json() as { hint: string };
        expect(body.hint).toContain('stdout');
    });
});
