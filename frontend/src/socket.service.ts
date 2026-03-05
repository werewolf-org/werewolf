import { io, Socket } from 'socket.io-client';
import { getState, resetState, setState, type LocalAppState } from './store';
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
        if (this.socket?.connected) return;

        const URL = import.meta.env.VITE_API_URL || '';
        
        this.socket = io(URL, {
            transports: ['websocket'], // Force websocket
            reconnection: true,
        });

        this.setupListeners();
    }

    public disconnect(): void {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
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

    public vote(voteTargetUUID: string) {
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
            setState({ isConnected: true });
        });

        this.socket.on('disconnect', () => {
            console.log('Socket disconnected');
            setState({ isConnected: false });
        });

        this.socket.on('error', (data: { message: string }) => {
            console.error('Socket Error:', data.message);
            alert(data.message);
        });

        // --- Game Lifecycle Events ---
        this.socket.on('gameCreated', (data: { gameId: string }) => {
            setState({gameId: data.gameId});
            navigate(`#/game/${data.gameId}`);
        });

        this.socket.on('joinedGame', (data: { gameId: string, playerUUID: string }) => {
            localStorage.setItem('playerUUID', data.playerUUID);
            console.log('joined game with id: ', data.playerUUID);
            // setState({gameId: data.gameId});
            resetState();
        });

        this.socket.on('syncState', (data: Partial<LocalAppState> ) => {
            console.log('syncState, patch: ', data);
            setState(data);
        })

    }
}

export const socketService = SocketService.getInstance();
