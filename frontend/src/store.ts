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
    lovePartner: string | null,
}

export interface LocalAppState {
    isConnected: boolean,

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
    myVoteTargetUUID: string | null,
    lynchDone: boolean,
    sheriffElectionDone: boolean,
    winningTeam: string | null,
    
    // aggregated state (from game model)
    nominationsFinished: boolean;
    voteResults: Record<string, string | null> | null;
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

const state: LocalAppState = {
    isConnected: false,
    
    gameId: null,
    playerUUID: localStorage.getItem('playerUUID') ?? null,

    phase: null,
    activeNightRole: null,
    players: [],

    displayName: null,
    isManager: false,
    role: null,
    lovePartnerUUID: null,
    lovePartnerConfirmed: false,
    readyForNight: false,
    myVoteTargetUUID: null,
    lynchDone: false,
    sheriffElectionDone: false,
    winningTeam: null,

    nominationsFinished: false,
    voteResults: null,
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
}

export function resetState(): void {
    Object.assign(state, {
        playerUUID: localStorage.getItem('playerUUID') ?? null,

        isConnected: false,

        phase: null,
        activeNightRole: null,
        players: [],

        displayName: null,
        isManager: false,
        role: null,
        lovePartnerUUID: null,
        lovePartnerConfirmed: false,
        readyForNight: false,
        myVoteTargetUUID: null,
        lynchDone: false,
        sheriffElectionDone: false,

        voteResults: null,
        votedOutUUID: null,
        werewolfVotes: null,
        werewolfVictim: null,
        witchUsedHealingPotion: false,
        witchUsedKillingPotion: false,
        redLadySleepoverUUID: null,
        seerRevealUUID: null,
        seerRevealRole: null,
        cupidFirstLoverUUID: null,
        cupidSecondLoverUUID: null,
        cupidFirstLoverConfirmed: false,
        cupidSecondLoverConfirmed: false,

    });
}