import { describe, it, expect, afterEach } from 'vitest';
import { TestGame } from './harness.js';
import { Phase } from '@shared/phases.js';
import { Role } from '@shared/roles.js';

// Smoke test for the harness itself: if this is red, no other e2e suite means anything.

const SIX_PLAYERS: Record<string, number> = {
    [Role.WEREWOLF]: 2,
    [Role.SEER]: 1,
    [Role.WITCH]: 1,
    [Role.CUPID]: 1,
    [Role.VILLAGER]: 1,
};

let game: TestGame | null = null;

afterEach(async () => {
    await game?.close();
    game = null;
});

describe('harness', () => {
    it('gets six players from lobby to the first night over real sockets', async () => {
        game = await TestGame.create({ playerCount: 6 });

        expect(game.gameId).toMatch(/^[A-Z0-9]{4}$/);
        expect(game.manager.playerUUID).toBe(game.clients[0].playerUUID);

        await game.setupAndStart(SIX_PLAYERS);

        await game.waitForPhaseEverywhere(Phase.NIGHT);

        // Every player knows their own role, and the composition matches the request
        const roles = game.clients.map((c) => c.state?.role);
        expect(roles.filter((r) => r === Role.WEREWOLF)).toHaveLength(2);
        expect(roles.filter((r) => r === Role.SEER)).toHaveLength(1);
        expect(roles.filter((r) => r === Role.WITCH)).toHaveLength(1);
        expect(roles.filter((r) => r === Role.CUPID)).toHaveLength(1);
        expect(roles.filter((r) => r === Role.VILLAGER)).toHaveLength(1);

        // The first sub-turn is the first role in the night order, whoever that is
        const firstTurn = game.clients[0].state?.activeNightRole;
        expect(firstTurn).not.toBeNull();

        game.expectNoErrors();
    });

    it('keeps each player on their own snapshot', async () => {
        game = await TestGame.create({ playerCount: 6 });
        await game.setupAndStart(SIX_PLAYERS);

        const wolves = game.clientsWithRole(Role.WEREWOLF);
        const others = game.clients.filter((c) => c.state?.role !== Role.WEREWOLF);

        expect(wolves).toHaveLength(2);
        expect(others).toHaveLength(4);

        // A villager may not see the werewolf vote map or the wolves' identities
        for (const client of others) {
            expect(client.state?.werewolfVotes).toBeNull();
            const visibleRoles = (client.state?.players ?? []).map((p) => p.role).filter((r) => r !== null);
            expect(visibleRoles).toHaveLength(0);
        }
    });
});
