import { io, Socket } from 'socket.io-client';
import { getState, resetState, setState, storePlayerUUID, type LocalAppState } from './store';
import { navigate } from './router';

class SocketService {
    private socket: Socket | null = null;
    private static instance: SocketService;
    // DOM-level "the user came back" listeners are registered once, not on every reconnect.
    private domListenersAttached = false;

    // Singleton accessor
    public static getInstance(): SocketService {
        if (!SocketService.instance) {
            SocketService.instance = new SocketService();
        }
        return SocketService.instance;
    }

    public connect(): void {
        // Guard on the socket existing, not on it being connected: a socket that is
        // still reconnecting must not be replaced by a second Manager.
        if (this.socket) return;

        const URL = import.meta.env.VITE_API_URL || '';
        
        this.socket = io(URL, {
            transports: ['websocket'], // Force websocket
            reconnection: true,
        });

        this.setupListeners();
    }

    public disconnect(): void {
        if (!this.socket) return;

        // Drop the handlers before tearing the socket down so a retry never
        // stacks a second set of listeners on top of the old one.
        this.socket.removeAllListeners();
        this.socket.disconnect();
        this.socket = null;
    }

    // --- Actions (Emits) ---

    public createGame() {
        this.socket?.emit('createGame');
    }

    public joinGame(gameId: string, playerUUID: string | null ) {
        this.socket?.emit('joinGame', { gameId, playerUUID });
    }

    public changeName(playerName: string) {
        const gameId = getState().gameId;
        this.socket?.emit('changeName', { gameId, playerName });
    }

    public closeJoining() {
        const gameId = getState().gameId;
        this.socket?.emit('closeJoining', { gameId });
    }

    public roleDistribution(roles: Record<string, number>) {
        const gameId = getState().gameId;
        this.socket?.emit('roleDistribution', { gameId, roles });
    }

    public startGame() {
        const gameId = getState().gameId;
        this.socket?.emit('startGame', { gameId });
    }

    public nominate(nominationUUID: string | false) {
        const gameId = getState().gameId;
        this.socket?.emit('nominate', { gameId, nominationUUID });
    }

    public vote(voteTargetUUID: string | false) {
        const gameId = getState().gameId;
        this.socket?.emit('vote', { gameId, voteTargetUUID });
    }

    public readyForNight() {
        const gameId = getState().gameId;
        this.socket?.emit('readyForNight', { gameId });
    }

    public acceptSheriffRole() {
        const gameId = getState().gameId;
        this.socket?.emit('acceptSheriffRole', { gameId });
    }

    // GM-only escape hatch: advances the current phase by exactly one step.
    public managerAdvance() {
        const gameId = getState().gameId;
        this.socket?.emit('managerAdvance', { gameId });
    }

    // Role specific emits

    public werewolfVote(targetUUID: string) {
        const gameId = getState().gameId;
        this.socket?.emit('werewolfVote', { gameId, targetUUID });
    }
    
    public revealRole(revealUUID: string) {
        const gameId = getState().gameId;
        this.socket?.emit('revealRole', ({gameId, revealUUID}));
    }

    public seerConfirmed() {
        const gameId = getState().gameId;
        this.socket?.emit('seerConfirmed', { gameId });
    }
    
    public sleepOver(sleepoverUUID: string) {
        const gameId = getState().gameId;
        this.socket?.emit('sleepover', {gameId, sleepoverUUID})
    }

    public usePotion(type: 'HEAL' | 'KILL', killUUID: string | null) {
        const gameId = getState().gameId;
        const heal: boolean = type === 'HEAL';
        this.socket?.emit('usePotion', { gameId, heal, killUUID });
    }

    public witchConfirms() {
        const gameId = getState().gameId;
        this.socket?.emit('witchConfirms', { gameId });
    }

    public bindLovers(firstPlayerUUID: string, secondPlayerUUID: string) {
        const gameId = getState().gameId;
        this.socket?.emit('bindLovers', { gameId, firstPlayerUUID, secondPlayerUUID });
    }

    public confirmLoverBond() {
        const gameId = getState().gameId;
        this.socket?.emit('confirmLoverBond', { gameId });
    }

    // --- Listeners (Dispatch to Store/Router) ---

    // Re-announce the seat we already hold. joinGame is idempotent on the server: it binds
    // this socket to the seat and answers with a tailored snapshot. It is the single
    // catch-up path for every shape of return (reconnect, tab resume, network online).
    private rejoinCurrentGame(): void {
        const { gameId, playerUUID } = getState();
        if (gameId && playerUUID && this.socket?.connected) {
            this.joinGame(gameId, playerUUID);
        }
    }

    private setupListeners() {
        if (!this.socket) return;

        // --- Basic Events ---

        this.socket.on('connect', () => {
            console.log('Socket connected:', this.socket?.id);

            // Every (re)connect gets a fresh socket.id while the server still maps our
            // seat to the previous one. Re-announce ourselves before anything else
            // depends on the socketId -> player mapping.
            this.rejoinCurrentGame();

            setState({ isConnected: true, connectionError: null });
        });

        this.socket.on('disconnect', () => {
            console.log('Socket disconnected');
            setState({ isConnected: false });
        });

        this.socket.on('connect_error', (err: Error) => {
            console.error('Socket connection error:', err.message);
            setState({
                connectionError: `Cannot reach the game server (${err.message}). Retrying...`,
            });
        });

        this.socket.on('error', (data: { message: string }) => {
            console.error('Socket Error:', data.message);
            // Non-blocking: the game page renders this as a toast. alert() freezes the
            // page's timers, so a rejected action could stop the socket from answering
            // its ping and take the whole connection down with it.
            setState({ lastError: data.message });
        });

        // --- Game Lifecycle Events ---
        this.socket.on('gameCreated', (data: { gameId: string }) => {
            setState({gameId: data.gameId});
            navigate(`#/game/${data.gameId}`);
        });

        this.socket.on('joinedGame', (data: { gameId: string, playerUUID: string }) => {
            // Persist the seat under its game only: the same id must never be
            // offered to a different game.
            storePlayerUUID(data.gameId, data.playerUUID);
            console.log('joined game with id: ', data.playerUUID);
            resetState();
            // resetState() clears the per-game mirror; remember which game we belong to
            // so a reconnect can re-emit joinGame before the next snapshot arrives.
            setState({ gameId: data.gameId, playerUUID: data.playerUUID });
        });

        this.socket.on('syncState', (data: Partial<LocalAppState> ) => {
            console.log('syncState, patch: ', data);
            // A snapshot means the join/action that preceded it worked.
            setState({ ...data, lastError: null });
        })

        // Phones freeze the page (and its timers) when the screen locks or the browser is
        // sent to the background. On resume the socket can still look connected while the
        // server has already dropped it, and snapshots that arrived in between can be
        // stuck in the socket's buffer. Asking for the current state is idempotent and is
        // what makes a returning phone catch up without a manual refresh.
        if (!this.domListenersAttached) {
            this.domListenersAttached = true;
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') this.rejoinCurrentGame();
            });
            window.addEventListener('pageshow', () => this.rejoinCurrentGame());
            window.addEventListener('online', () => this.rejoinCurrentGame());
        }
    }
}

export const socketService = SocketService.getInstance();
