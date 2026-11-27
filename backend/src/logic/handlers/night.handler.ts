import { Role } from "@shared/roles.js";
import type { Game } from "../../models.js";
import { getNextToWakeUp, getWerewolfVictimUUID } from "../selectors/night.selectors.js";
import { Phase } from "@shared/phases.js";
import { resolveNightDeaths } from "../rules/deaths.js";

const resolveNightActions = (game: Game): void => {
    const witch = game.players.find((player) => player.role === Role.WITCH);
    const witchAction = witch?.nightAction;
    const redLady = game.players.find((player) => player.role === Role.RED_LADY);
    const redLadyAction = redLady?.nightAction;

    resolveNightDeaths(game, {
        werewolfVictimUUID: getWerewolfVictimUUID(game),
        witchHeal: witchAction?.heal ?? false,
        witchKillUUID: witchAction?.killUUID ?? null,
        // a missing target means "did not visit anyone"; handleSleepover never stores undefined
        redLadySleepoverUUID: redLadyAction?.sleepoverUUID ?? null,
    });

    game.players.forEach(p => p.nightAction = null);
}

const startDay = (game: Game): void => {
    // resolve deaths before mutating the phase: if this throws, the game stays in NIGHT
    resolveNightActions(game);

    // End of Night -> Start Day or Sheriff Election
    game.activeNightRole = null;
    game.lynchDone = false;
    
    if (game.round === 0 && !game.sheriffElectionDone) {
        game.phase = Phase.SHERIFF_ELECTION;
    } else {
        game.phase = Phase.DAY;
    }
}

export class NightHandler {
    static nextRole(game: Game): void {
        const nextActiveRole = getNextToWakeUp(game, false);
        // Advance to the next role or go to end of night
        if (nextActiveRole) game.activeNightRole = nextActiveRole;
        else startDay(game);
    }

    // GM escape hatch: advance the night by exactly one sub-turn (and resolve it from the last role).
    // Safe to call at any time: outside NIGHT or with no active role it is a no-op.
    static forceNextRole(game: Game): void {
        if (game.phase !== Phase.NIGHT || !game.activeNightRole) return;
        NightHandler.nextRole(game);
    }
}
