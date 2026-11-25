import { io, Socket } from 'socket.io-client';
import { getState, resetState, setState, storePlayerUUID, type LocalAppState } from './store';
import { navigate } from './router';

class SocketService {
    private socket: Socket | null = null;
    private static instance: SocketService;

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

    private setupListeners() {
        if (!this.socket) return;

        // --- Basic Events ---

        this.socket.on('connect', () => {
            console.log('Socket connected:', this.socket?.id);

            // Every (re)connect gets a fresh socket.id while the server still maps our
            // seat to the previous one. Re-announce ourselves before anything else
            // depends on the socketId -> player mapping.
            const { gameId, playerUUID } = getState();
            if (gameId && playerUUID) {
                this.joinGame(gameId, playerUUID);
            }

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
            setState({ lastError: data.message });

            // Without a phase the game page renders its own terminal error state.
            // Every other view still relies on the alert for feedback.
            if (getState().phase !== null) {
                alert(data.message);
            }
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

    }
}

export const socketService = SocketService.getInstance();
