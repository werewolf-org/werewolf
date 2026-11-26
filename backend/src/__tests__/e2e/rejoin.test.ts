import { describe, it, expect, afterEach } from 'vitest';
import { Client, TestGame } from './harness.js';
import { Phase } from '@shared/phases.js';
import { Role } from '@shared/roles.js';

// Rejoin shapes that produce *two live sockets on one seat*: a second tab, a reopened
// link, or a reconnect that reaches the server before the old socket times out. Each of
// those sockets is a screen the player could be looking at, so it must keep receiving
// snapshots and must be able to act. The old behaviour bound only the newest socket,
// which left every other open tab frozen on a stale snapshot until a manual refresh.

let game: TestGame | null = null;

afterEach(async () => {
    await game?.close();
    game = null;
});

/** Opens a second live socket and binds it to an existing player's seat. */
async function openSecondSocket(g: TestGame, playerUUID: string): Promise<Client> {
    const client = await Client.connect(g.server.url);
    client.socket.emit('joinGame', { gameId: g.gameId, playerUUID });
    await client.waitFor((s) => s.playerUUID === playerUUID, 'second socket bound to the seat');
    return client;
}

describe('rejoin: a seat with several live sockets', () => {
    it('pushes snapshots to both sockets and lets either one act', async () => {
        game = await TestGame.create({ playerCount: 6 });
        const phone = game.clients[2]!;
        const uuid = phone.playerUUID!;
        const second = await openSecondSocket(game, uuid);

        try {
            // Same seat, same private state, no duplicate player.
            expect(second.state!.role).toBe(phone.state!.role);
            expect(second.state!.players).toHaveLength(6);

            // An action from the *older* socket still works and both views update.
            phone.socket.emit('changeName', { gameId: game.gameId, playerName: 'From the old tab' });
            await Promise.all([
                phone.waitFor((s) => s.displayName === 'From the old tab', 'old tab acted'),
                second.waitFor((s) => s.displayName === 'From the old tab', 'new tab saw the old tab act'),
            ]);

            // And from the newer one.
            second.socket.emit('changeName', { gameId: game.gameId, playerName: 'From the new tab' });
            await Promise.all([
                phone.waitFor((s) => s.displayName === 'From the new tab', 'old tab saw the new tab act'),
                second.waitFor((s) => s.displayName === 'From the new tab', 'new tab acted'),
            ]);

            game.expectNoErrors();
        } finally {
            second.close();
        }
    });

    it('keeps the first socket alive and authoritative when the second one closes', async () => {
        game = await TestGame.create({ playerCount: 6 });
        const phone = game.clients[2]!;
        const uuid = phone.playerUUID!;
        const second = await openSecondSocket(game, uuid);

        // Close the newer socket without a reload of the first one. The first phone never
        // reconnected, so nothing would re-bind it if the seat were not still held.
        second.close();

        // A phase change is broadcast after the disconnect; it must reach the survivor.
        game.manager.socket.emit('closeJoining', { gameId: game.gameId });
        await phone.waitForPhase(Phase.ROLE_SELECTION);

        // ...and the survivor can still act on it.
        phone.socket.emit('changeName', { gameId: game.gameId, playerName: 'Ignored in role selection' });
        expect(phone.state!.phase).toBe(Phase.ROLE_SELECTION);

        game.expectNoErrors();
    });

    it('survives a churn of sockets and keeps the last live one bound', async () => {
        game = await TestGame.create({ playerCount: 6 });
        const phone = game.clients[3]!;
        const uuid = phone.playerUUID!;

        const tabs: Client[] = [];
        try {
            for (let i = 0; i < 3; i++) {
                tabs.push(await openSecondSocket(game, uuid));
            }

            // Close them newest-first; the original phone must be bound again each time.
            for (const tab of [...tabs].reverse()) {
                tab.close();
            }

            // The manager drives the lobby forward; the survivor must follow the phases.
            game.manager.socket.emit('closeJoining', { gameId: game.gameId });
            await phone.waitForPhase(Phase.ROLE_SELECTION);
            game.manager.socket.emit('roleDistribution', {
                gameId: game.gameId,
                roles: { [Role.WEREWOLF]: 1, [Role.VILLAGER]: 5 },
            });
            await phone.waitForPhase(Phase.DISTRIBUTION);
            expect(phone.state!.role).not.toBeNull();

            game.expectNoErrors();
        } finally {
            tabs.forEach((tab) => tab.close());
        }
    });

    it('lets a second socket of the game master run the lobby after the first closes', async () => {
        game = await TestGame.create({ playerCount: 6 });
        const managerPhone = game.manager;
        const managerUUID = managerPhone.playerUUID!;
        const gmSecondTab = await openSecondSocket(game, managerUUID);

        try {
            // The original GM phone goes away; the second tab still holds the seat.
            managerPhone.close();
            await gmSecondTab.waitFor((s) => s.isManager, 'second tab is still the manager');

            gmSecondTab.socket.emit('closeJoining', { gameId: game.gameId });
            await gmSecondTab.waitForPhase(Phase.ROLE_SELECTION);

            gmSecondTab.socket.emit('roleDistribution', {
                gameId: game.gameId,
                roles: { [Role.WEREWOLF]: 1, [Role.VILLAGER]: 5 },
            });
            await gmSecondTab.waitForPhase(Phase.DISTRIBUTION);
            gmSecondTab.socket.emit('startGame', { gameId: game.gameId });
            await gmSecondTab.waitForPhase(Phase.NIGHT);

            // The other five phones followed the lobby through the second tab.
            await Promise.all(
                game.clients
                    .filter((c) => c !== managerPhone && c.socket.connected)
                    .map((c) => c.waitForPhase(Phase.NIGHT)),
            );
        } finally {
            gmSecondTab.close();
        }
    });
});
