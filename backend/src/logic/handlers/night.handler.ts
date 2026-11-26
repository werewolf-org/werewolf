import { Role } from "@shared/roles.js";
import type { Game } from "../../models.js";
import { getNextToWakeUp, getWerewolfVictimUUID } from "../selectors/night.selectors.js";
import { Phase } from "@shared/phases.js";
import { handleSheriffDeath } from "./vote.handler.js";

const resolveNightActions = (game: Game): void => {
    const werewolfTargetUUID = getWerewolfVictimUUID(game);

    const witch = game.players.find((player) => player.role === Role.WITCH)
    const witchAction = witch?.nightAction as Record<string, any>;
    const witchHeal: boolean = witchAction?.heal ?? false;
    const witchKillUUID: string | null = witchAction?.killUUID ?? null; 

    const redLady = game.players.find((player) => player.role === Role.RED_LADY);
    const redLadyAction = redLady?.nightAction as Record<string, any>;
    // a missing target means "did not visit anyone"; handleSleepover never stores undefined
    const redLadySleepoverUUID: string | null = redLadyAction?.sleepoverUUID ?? null;

    let dyingPlayerUUIDs: string[] = [];

    // werewolf kill
    const werewolfVictimUUID = werewolfTargetUUID && !witchHeal ? werewolfTargetUUID : null;
    if(werewolfVictimUUID) dyingPlayerUUIDs.push(werewolfVictimUUID);

    // witch kill (healing and killing the same player must not kill them)
    const isHealedVictim = witchHeal && witchKillUUID !== null && witchKillUUID === werewolfTargetUUID;
    const witchKillTargetUUID = witchKillUUID && !isHealedVictim ? witchKillUUID : null;
    if(witchKillTargetUUID && !dyingPlayerUUIDs.includes(witchKillTargetUUID)) dyingPlayerUUIDs.push(witchKillTargetUUID);

    // red lady logic
    const redLadyUUID = game.players.filter((player) => player.isAlive).find((player) => player.role === Role.RED_LADY)?.playerUUID ?? null;
    if(redLadyUUID) {
        // She escapes an attack aimed at her, and dies when her host was killed. She does NOT
        // escape the witch's poison - only the werewolves' attack - so a poisoned red lady dies
        // and the one-shot potion is not silently wasted.
        if(witchKillTargetUUID !== redLadyUUID) {
            const victimsWithoutRedLady = dyingPlayerUUIDs.filter((victim) => victim !== redLadyUUID);
            if(redLadySleepoverUUID && victimsWithoutRedLady.includes(redLadySleepoverUUID) && !victimsWithoutRedLady.includes(redLadyUUID)) {
                victimsWithoutRedLady.push(redLadyUUID);
            }
            dyingPlayerUUIDs = victimsWithoutRedLady;
        }
    }

    // TODO: edge case - what if the red lady sleeps at the love partner's place

    // collect every death before mutating anything, so a throw cannot leave a half-resolved dawn
    const deceasedUUIDs = new Set<string>();
    dyingPlayerUUIDs.forEach((victimUUID) => {
        const victim = game.players.find((player) => player.playerUUID === victimUUID);
        // never re-kill a corpse (e.g. a stale vote for a dead player)
        if(!victim || !victim.isAlive) return;
        deceasedUUIDs.add(victimUUID);
        // check couple dying
        if(victim.lovePartner) {
            const lovePartner = game.players.find((player) => player.playerUUID === victim.lovePartner);
            if(!lovePartner) throw new Error(`Player with ${victim.lovePartner} does not exist, cannot be a love partner`);
            if(lovePartner.isAlive && lovePartner.playerUUID) deceasedUUIDs.add(lovePartner.playerUUID);
        }
    });

    deceasedUUIDs.forEach((deceasedUUID) => {
        const player = game.players.find((p) => p.playerUUID === deceasedUUID);
        if(player) player.isAlive = false;
    });

    // all deaths are final here (werewolf victim, witch kill, lover chain, red lady):
    // a sheriff must not keep the badge in death
    handleSheriffDeath(game);

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
