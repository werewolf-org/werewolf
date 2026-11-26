import { io as ioClient } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { startGameServer } from '../../server.js';
import type { GameServerHandle } from '../../server.js';
import { GameStore } from '../../store/game.store.js';
import { Phase } from '@shared/phases.js';

// End-to-end harness: starts a real backend on an ephemeral port and drives it with
// real socket.io clients, exactly like N phones would. Assertions are made on the
// tailored snapshots each client receives, because that is all a player ever sees.

export interface SnapshotPlayer {
    playerUUID: string;
    displayName: string;
    isAlive: boolean;
    isSheriff: boolean;
    role: string | null;
    nomination: string | false | null;
    hasVoted: boolean;
}

export interface Snapshot {
    gameId: string;
    playerUUID: string;
    phase: Phase;
    activeNightRole: string | null;
    players: SnapshotPlayer[];
    isManager: boolean;
    displayName: string | null;
    role: string | null;
    lovePartnerUUID: string | null;
    lovePartnerConfirmed: boolean;
    readyForNight: boolean;
    myNominationUUID: string | false | null;
    myVoteTargetUUID: string | false | null;
    lynchDone: boolean;
    sheriffElectionDone: boolean;
    winningTeam: string | null;
    nominationsFinished: boolean;
    voteResults: Record<string, string | false> | null;
    voteProgress: { voted: number; total: number } | null;
    votedOutUUID: string | null;
    werewolfVotes: Record<string, string> | null;
    werewolfVictim: string | null;
    witchUsedHealingPotion: boolean;
    witchUsedKillingPotion: boolean;
    redLadySleepoverUUID: string | null;
    seerRevealUUID: string | null;
    seerRevealRole: string | null;
    cupidSelectedLovers: boolean;
    cupidFirstLoverUUID: string | null;
    cupidSecondLoverUUID: string | null;
    cupidFirstLoverConfirmed: boolean;
    cupidSecondLoverConfirmed: boolean;
}

const DEFAULT_TIMEOUT = 5000;

interface Waiter {
    predicate: (state: Snapshot) => boolean;
    resolve: (state: Snapshot) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export class Client {
    readonly socket: Socket;
    gameId: string | null = null;
    playerUUID: string | null = null;
    state: Snapshot | null = null;
    history: Snapshot[] = [];
    errors: string[] = [];
    connectionErrors: string[] = [];

    private waiters: Waiter[] = [];

    private constructor(socket: Socket, gameId: string | null) {
        this.socket = socket;
        this.gameId = gameId;

        this.socket.on('gameCreated', ({ gameId }: { gameId: string }) => {
            this.gameId = gameId;
        });

        this.socket.on('joinedGame', ({ gameId, playerUUID }: { gameId: string; playerUUID: string }) => {
            this.gameId = gameId;
            this.playerUUID = playerUUID;
        });

        this.socket.on('syncState', (state: Snapshot) => {
            this.state = state;
            this.history.push(state);
            this.playerUUID = state.playerUUID;
            this.gameId = state.gameId;
            this.resolveWaiters();
        });

        this.socket.on('error', ({ message }: { message: string }) => {
            this.errors.push(message);
        });

        this.socket.on('connect_error', (error: Error) => {
            this.connectionErrors.push(error.message);
        });

        // The real frontend re-emits joinGame whenever the socket (re)connects, because
        // socket.io hands out a new id after a blip. Mirror that here, or every rejoin
        // test would be testing a client the app does not have.
        this.socket.on('connect', () => {
            if (this.gameId && this.playerUUID) {
                this.socket.emit('joinGame', { gameId: this.gameId, playerUUID: this.playerUUID });
            }
        });
    }

    static async connect(url: string, gameId: string | null = null): Promise<Client> {
        const socket = ioClient(url, {
            transports: ['websocket'],
            reconnection: true,
            forceNew: true,
        });
        const client = new Client(socket, gameId);

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Client could not connect to ${url}`)), DEFAULT_TIMEOUT);
            socket.once('connect', () => {
                clearTimeout(timer);
                resolve();
            });
            socket.once('connect_error', (error: Error) => {
                clearTimeout(timer);
                reject(error);
            });
        });

        return client;
    }

    private resolveWaiters(): void {
        if (!this.state) return;
        const state = this.state;
        const remaining: Waiter[] = [];
        for (const waiter of this.waiters) {
            if (waiter.predicate(state)) {
                clearTimeout(waiter.timer);
                waiter.resolve(state);
            } else {
                remaining.push(waiter);
            }
        }
        this.waiters = remaining;
    }

    /** Resolves with the current state if it already matches, otherwise with the next matching snapshot. */
    waitFor(predicate: (state: Snapshot) => boolean, label = 'condition', timeoutMs = DEFAULT_TIMEOUT): Promise<Snapshot> {
        if (this.state && predicate(this.state)) return Promise.resolve(this.state);

        return new Promise<Snapshot>((resolve, reject) => {
            const waiter: Waiter = {
                predicate,
                resolve,
                reject,
                timer: setTimeout(() => {
                    this.waiters = this.waiters.filter((w) => w !== waiter);
                    reject(new Error(
                        `Timed out after ${timeoutMs}ms waiting for "${label}" ` +
                        `(player ${this.playerUUID ?? 'unjoined'}, last phase ${this.state?.phase ?? 'none'})`
                    ));
                }, timeoutMs),
            };
            this.waiters.push(waiter);
        });
    }

    waitForPhase(phase: Phase, timeoutMs = DEFAULT_TIMEOUT): Promise<Snapshot> {
        return this.waitFor((s) => s.phase === phase, `phase ${phase}`, timeoutMs);
    }

    waitForTurn(role: string, timeoutMs = DEFAULT_TIMEOUT): Promise<Snapshot> {
        return this.waitFor(
            (s) => s.phase === Phase.NIGHT && s.activeNightRole === role,
            `night turn of ${role}`,
            timeoutMs,
        );
    }

    async emitWithWait(event: string, payload: unknown, label: string, timeoutMs = DEFAULT_TIMEOUT): Promise<Snapshot> {
        const before = this.history.length;
        this.socket.emit(event, payload);
        return this.waitFor(
            () => this.history.length > before || this.errors.length > 0,
            label,
            timeoutMs,
        );
    }

    /** Simulates a network blip: socket.io assigns a new socket id on reconnect. */
    async dropAndReconnect(): Promise<void> {
        this.socket.disconnect();
        this.socket.connect();
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Client could not reconnect')), DEFAULT_TIMEOUT);
            this.socket.once('connect', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    close(): void {
        this.socket.removeAllListeners();
        this.socket.disconnect();
    }
}

export interface GameSetup {
    playerCount?: number;
    roles?: Record<string, number>;
}

export class TestGame {
    readonly server: GameServerHandle;
    readonly clients: Client[] = [];
    gameId = '';

    private constructor(server: GameServerHandle) {
        this.server = server;
    }

    /** Starts a server and a lobby with `playerCount` clients; clients[0] is the game manager. */
    static async create({ playerCount = 6 }: GameSetup = {}): Promise<TestGame> {
        GameStore.getInstance().clear();
        const server = await startGameServer(0);
        const game = new TestGame(server);

        const host = await Client.connect(server.url);
        host.socket.emit('createGame');
        const created = await new Promise<{ gameId: string }>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Game was not created')), DEFAULT_TIMEOUT);
            host.socket.once('gameCreated', (data: { gameId: string }) => {
                clearTimeout(timer);
                resolve(data);
            });
        });
        host.gameId = created.gameId;
        game.gameId = created.gameId;

        // The frontend joins as a normal player right after gameCreated, so the host is not
        // a player until it joins. Keeping the same order here avoids a phantom off-by-one.
        host.socket.emit('joinGame', { gameId: game.gameId, playerUUID: null });
        await host.waitFor(() => host.playerUUID !== null, 'host joined');
        game.clients.push(host);

        for (let i = 1; i < playerCount; i++) {
            game.clients.push(await game.joinPlayer());
        }

        await Promise.all(game.clients.map((c) => c.waitFor((s) => s.players.length === playerCount, 'all players in lobby')));
        return game;
    }

    async joinPlayer(name?: string): Promise<Client> {
        const client = await Client.connect(this.server.url);
        client.socket.emit('joinGame', { gameId: this.gameId, playerUUID: null });
        await client.waitFor(() => client.playerUUID !== null, 'joined game');
        if (name) {
            client.socket.emit('changeName', { gameId: this.gameId, playerName: name });
            await client.waitFor((s) => s.displayName === name, `name ${name}`);
        }
        return client;
    }

    /** Reconnects an existing player in a new client (page reload / new socket). */
    async rejoinPlayer(playerUUID: string): Promise<Client> {
        const client = await Client.connect(this.server.url);
        client.socket.emit('joinGame', { gameId: this.gameId, playerUUID });
        await client.waitFor((s) => s.playerUUID === playerUUID, 'rejoined game');
        return client;
    }

    get manager(): Client {
        const manager = this.clients.find((c) => c.state?.isManager);
        if (!manager) throw new Error('No game manager in this game');
        return manager;
    }

    async closeJoining(): Promise<void> {
        this.manager.socket.emit('closeJoining', { gameId: this.gameId });
        await Promise.all(this.clients.map((c) => c.waitForPhase(Phase.ROLE_SELECTION)));
    }

    async distributeRoles(roles: Record<string, number>): Promise<void> {
        this.manager.socket.emit('roleDistribution', { gameId: this.gameId, roles });
        await Promise.all(this.clients.map((c) => c.waitForPhase(Phase.DISTRIBUTION)));
    }

    async startGame(): Promise<void> {
        this.manager.socket.emit('startGame', { gameId: this.gameId });
        await Promise.all(this.clients.map((c) => c.waitForPhase(Phase.NIGHT)));
    }

    /** Lobby -> role selection -> distribution -> night. Roles must sum to the player count. */
    async setupAndStart(roles: Record<string, number>): Promise<void> {
        await this.closeJoining();
        await this.distributeRoles(roles);
        await this.startGame();
    }

    clientsWithRole(role: string): Client[] {
        return this.clients.filter((c) => c.state?.role === role);
    }

    aliveClients(): Client[] {
        return this.clients.filter((c) => c.state?.players.find((p) => p.playerUUID === c.playerUUID)?.isAlive);
    }

    clientByUUID(playerUUID: string): Client {
        const client = this.clients.find((c) => c.playerUUID === playerUUID);
        if (!client) throw new Error(`No client with uuid ${playerUUID}`);
        return client;
    }

    /** Waits until every client observes the same phase. */
    async waitForPhaseEverywhere(phase: Phase, timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
        await Promise.all(this.clients.filter((c) => c.socket.connected).map((c) => c.waitForPhase(phase, timeoutMs)));
    }

    expectNoErrors(): void {
        const failed = this.clients.filter((c) => c.errors.length > 0);
        if (failed.length > 0) {
            const details = failed.map((c) => `${c.playerUUID}: ${c.errors.join(' | ')}`).join('\n');
            throw new Error(`Unexpected server errors:\n${details}`);
        }
    }

    async close(): Promise<void> {
        this.clients.forEach((c) => c.close());
        await this.server.close();
        GameStore.getInstance().clear();
    }
}
