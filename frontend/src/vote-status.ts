import type { LocalAppState, LocalPlayerModel } from './store';

/** "Ben, Clara and Deniz" for a sentence, not an Oxford-comma list. */
export function nameList(names: string[]): string {
    if (names.length <= 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Who the table is still waiting for.
 *
 * Participation is public (`players[].hasVoted`, `players[].readyForNight`); the choice is
 * not. Naming the people who have not acted is what turns a progress counter into something
 * actionable, and it leaks nothing: at a table you can already see whose phone is still up.
 * The second person is marked "you", because "Waiting for Ben" when Ben is holding the phone
 * is a status, not an instruction.
 */
function waitingNames(state: LocalAppState, isWaiting: (player: LocalPlayerModel) => boolean, everyoneDone: string): string {
    const me = state.players.find(p => p.playerUUID === state.playerUUID);
    const waiting = state.players.filter(p => p.isAlive && isWaiting(p));
    if (waiting.length === 0) return everyoneDone;

    const iAmWaiting = !!me && me.isAlive && isWaiting(me);
    const others = waiting.filter(p => p.playerUUID !== state.playerUUID);
    if (iAmWaiting) {
        if (others.length === 0) return 'Waiting for you.';
        const listed = nameList(others.map(p => p.displayName || 'Unnamed Player'));
        return others.length === 1
            ? `Waiting for you and ${listed}.`
            : `Waiting for you, ${listed}.`;
    }
    return `Waiting for ${nameList(waiting.map(p => p.displayName || 'Unnamed Player'))}.`;
}

/** Who has not cast a ballot in the trial or the sheriff election. */
export function waitingNamesText(state: LocalAppState): string {
    return waitingNames(state, p => !p.hasVoted, 'Everyone has decided.');
}

/** Who has not confirmed the lynch result, and is therefore holding up the night. */
export function readyNamesText(state: LocalAppState): string {
    return waitingNames(state, p => !p.readyForNight, 'Everyone is ready.');
}
