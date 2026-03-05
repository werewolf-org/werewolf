import { Role, ROLES } from "@shared/roles.js";
import type { Game } from "../../models.js";
import { getNextToWakeUp, getWerewolfVictimUUID } from "../selectors/night.selectors.js";
import { Phase } from "@shared/phases.js";

const resolveNightActions = (game: Game): void => {
    const werewolfTargetUUID = getWerewolfVictimUUID(game);

    const witch = game.players.find((player) => player.role === Role.WITCH)
    const witchAction = witch?.nightAction as Record<string, any>;
    const witchHeal: boolean = witchAction?.heal ?? false;
    const witchKillUUID: string | null = witchAction?.killUUID ?? null; 

    const redLady = game.players.find((player) => player.role === Role.RED_LADY);
    const redLadyAction = redLady?.nightAction as Record<string, any>;
    if(redLadyAction && redLadyAction.sleepoverUUID === undefined) throw new Error(`Red Lady Action exists but no targetUUID`)
    const redLadySleepoverUUID: string | null = redLadyAction?.sleepoverUUID ?? null;

    let dyingPlayerUUIDs: string[] = [];

    // werewolf kill
    if(werewolfTargetUUID && !witchHeal) dyingPlayerUUIDs.push(werewolfTargetUUID);

    // witch kill
    if(witchKillUUID && !dyingPlayerUUIDs.includes(witchKillUUID)) dyingPlayerUUIDs.push(witchKillUUID);

    // red lady logic
    const redLadyUUID = game.players.filter((player) => player.isAlive).find((player) => player.role === Role.RED_LADY)?.playerUUID ?? null;
    if(redLadyUUID) {
        dyingPlayerUUIDs = dyingPlayerUUIDs.filter((victim) => victim !== redLadyUUID);
        dyingPlayerUUIDs.forEach((victim) => {
            if(victim === redLadySleepoverUUID && !dyingPlayerUUIDs.includes(redLadyUUID)) dyingPlayerUUIDs.push(redLadyUUID)
        })
    }

    // TODO: edge case - what if the red lady sleeps at the love partner's place

    const dyingPlayers = game.players.filter(p => p.playerUUID && dyingPlayerUUIDs.includes(p.playerUUID))
    dyingPlayers.forEach(player => {
        player.isAlive = false;
        // check couple dying
        if(player.lovePartner) {
            const lovePartner = game.players.find(p => p.playerUUID === player.lovePartner);
            if(!lovePartner) throw new Error(`Player with ${player.lovePartner} does not exist, cannot be a love partner`);
            lovePartner.isAlive = false;
        }
    });
    game.players.forEach(p => p.nightAction = null);
}

const startDay = (game: Game): void => {
    // End of Night -> Start Day or Sheriff Election
    game.activeNightRole = null;
    game.lynchDone = false;
    
    if (game.round === 0 && !game.sheriffElectionDone) {
        game.phase = Phase.SHERIFF_ELECTION;
    } else {
        game.phase = Phase.DAY;
    }

    resolveNightActions(game);

    game.players.forEach((player) => player.nightAction = null);
}

export const NightHandler = {
    nextRole(game: Game): void {
        const nextActiveRole = getNextToWakeUp(game, false);
        // Advance to the next role or go to end of night
        if (nextActiveRole) game.activeNightRole = nextActiveRole;
        else startDay(game);
    },
}