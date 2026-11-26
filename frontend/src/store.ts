import { Role} from '@shared/roles.js'
import { Phase } from '@shared/phases';
import { View } from './base-view';

export interface LocalPlayerModel {
    playerUUID: string, 
    displayName: string,
    isAlive: boolean,
    isSheriff: boolean,
    role: Role | null,
    nomination: string | false | null,
    // Whether this player has cast their ballot in the current vote stage. Public on
    // purpose: the table is allowed to know who it is waiting for, never what they chose.
    hasVoted: boolean,
}

export interface LocalAppState {
    isConnected: boolean,
    connectionError: string | null,
    lastError: string | null,

    // global (game model mirror)
    gameId: string | null,

    phase: Phase| null,
    activeNightRole: Role | null,
    players: LocalPlayerModel[];
    
    // private (game model mirror)
    playerUUID: string | null,
    displayName: string | null,
    isManager: boolean,
    role: Role | null,
    lovePartnerUUID: string | null,
    lovePartnerConfirmed: boolean,
    readyForNight: boolean,
    myNominationUUID: string | false | null,
    myVoteTargetUUID: string | false | null,
    lynchDone: boolean,
    sheriffElectionDone: boolean,
    winningTeam: string | null,
    
    // aggregated state (from game model)
    nominationsFinished: boolean;
    voteResults: Record<string, string | false | null> | null;
    voteProgress: { voted: number; total: number } | null;
    votedOutUUID: string | null;

    werewolfVotes: Record<string, string> | null;
    werewolfVictim: string | null;

    witchUsedHealingPotion: boolean;
    witchUsedKillingPotion: boolean;

    redLadySleepoverUUID: string | null;

    seerRevealUUID: string | null;
    seerRevealRole: Role | null;

    cupidSelectedLovers: boolean;
    cupidFirstLoverUUID: string | null;
    cupidSecondLoverUUID: string | null;
    cupidFirstLoverConfirmed: boolean;
    cupidSecondLoverConfirmed: boolean;

}

// Single source of truth for "no game yet". Both the initial store and
// resetState() derive from this so the two can never drift apart.
function createInitialState(): LocalAppState {
    return {
        isConnected: false,
        connectionError: null,
        lastError: null,

        gameId: null,
        playerUUID: null,

        phase: null,
        activeNightRole: null,
        players: [],

        displayName: null,
        isManager: false,
        role: null,
        lovePartnerUUID: null,
        lovePartnerConfirmed: false,
        readyForNight: false,
        myNominationUUID: null,
        myVoteTargetUUID: null,
        lynchDone: false,
        sheriffElectionDone: false,
        winningTeam: null,

        nominationsFinished: false,
        voteResults: null,
        voteProgress: null,
        votedOutUUID: null,
        werewolfVotes: null,
        werewolfVictim: null,
        witchUsedHealingPotion: false,
        witchUsedKillingPotion: false,
        redLadySleepoverUUID: null,
        seerRevealUUID: null,
        seerRevealRole: null,
        cupidSelectedLovers: false,
        cupidFirstLoverUUID: null,
        cupidSecondLoverUUID: null,
        cupidFirstLoverConfirmed: false,
        cupidSecondLoverConfirmed: false,
    };
}

const state: LocalAppState = {
    ...createInitialState(),
};

// --- Per-game player identity ---
// A seat only exists inside one game, so the id is stored per game
// (`playerUUID:<gameId>`). One shared id would send game A's seat to game B.

const PLAYER_UUID_KEY_PREFIX = 'playerUUID:';
const LEGACY_PLAYER_UUID_KEY = 'playerUUID';

const playerUUIDKey = (gameId: string): string => `${PLAYER_UUID_KEY_PREFIX}${gameId}`;

export function getStoredPlayerUUID(gameId: string): string | null {
    const stored = localStorage.getItem(playerUUIDKey(gameId));
    if (stored) return stored;

    // One-time migration: older builds kept a single id for every game. Offer it
    // to the game being opened, then drop it so it cannot leak into another game.
    // It is only persisted once the backend confirms it (joinedGame).
    const legacy = localStorage.getItem(LEGACY_PLAYER_UUID_KEY);
    if (legacy) {
        localStorage.removeItem(LEGACY_PLAYER_UUID_KEY);
        return legacy;
    }

    return null;
}

export function storePlayerUUID(gameId: string, playerUUID: string): void {
    localStorage.setItem(playerUUIDKey(gameId), playerUUID);
}

export function clearStoredPlayerUUID(gameId: string): void {
    localStorage.removeItem(playerUUIDKey(gameId));
}


type Listener = (state: LocalAppState) => void;
const listeners = new Set<Listener>();

export function getState(): Readonly<LocalAppState> {
    return Object.freeze({ ...state });
}

export function setState(patch: Partial<LocalAppState>): void {
    Object.assign(state, patch);
    const updatedState = getState();
    listeners.forEach((fn) => fn(updatedState));
}

function subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// Subscribe to a specific part of the state and register it to a View's lifecycle.
// The callback fires once at subscribe time with the current value, so views do
// not need to hand-roll their first paint.
export function subscribeSelector<T>(
    view: View,
    selector: (state: LocalAppState) => T,
    fn: (value: T) => void
): void {
    let lastValue = selector(state);
    const unsub = subscribe((newState) => {
        const newValue = selector(newState);
        if (newValue !== lastValue) {
            lastValue = newValue;
            fn(newValue);
        }
    });
    view.addUnsub(unsub);

    fn(lastValue);
}

export function resetState(): void {
    setState({
        ...createInitialState(),

        // Note: we intentionally do NOT reset the connection fields here.
        // The socket is a global singleton that persists across game state resets.
        // Resetting them here would break the cold-start gate logic.
        isConnected: state.isConnected,
        connectionError: state.connectionError,

        // playerUUID is cleared with the rest: a seat belongs to one game, so the
        // game page re-reads its own per-game id before emitting joinGame.
    });
}
