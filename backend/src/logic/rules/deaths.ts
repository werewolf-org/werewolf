import { Role } from "@shared/roles.js";
import type { Game, Player } from "../../models.js";
import { logEvent } from "../../debug/log.js";

// Death resolution: the one place that decides who actually leaves the table.
//
// Both a lynch and a dawn end in the same shape: a set of named victims, the lovers
// who follow them, and the sheriff badge never staying with a corpse. Keeping that
// here means the night path cannot clear the badge differently from the day path.

export interface NightDeathInput {
    /** The pack's consensus victim, or null when they split or did not all vote. */
    werewolfVictimUUID: string | null;
    /** Whether the witch healed the pack's victim. */
    witchHeal: boolean;
    /** The witch's poison target, or null. */
    witchKillUUID: string | null;
    /** The red lady's host, or null when she stayed home. */
    redLadySleepoverUUID: string | null;
}

/** The badge never stays with a corpse. */
export const clearDeadSheriff = (game: Game): void => {
    if(!game.sheriffUUID) return;
    const sheriff = game.players.find((p) => p.playerUUID === game.sheriffUUID);
    if(sheriff?.isAlive) return;
    logEvent("info", "sheriff.cleared", { game: game.gameId, sheriff: sheriff?.displayName ?? game.sheriffUUID });
    game.sheriffUUID = null;
}

/**
 * Apply a set of deaths.
 *
 * Collects every death before mutating anything, so a missing lover leaves the table
 * untouched instead of half-resolved. A victim who is already dead is skipped and does
 * not take their lover with them. Returns the UUIDs whose `isAlive` flipped to false,
 * direct victims first, then the lovers they dragged along.
 */
export const resolveDeaths = (game: Game, victimUUIDs: readonly string[]): string[] => {
    const dying = new Set<Player>();

    victimUUIDs.forEach((victimUUID) => {
        const victim = game.players.find((player) => player.playerUUID === victimUUID);
        // never re-kill a corpse (e.g. a stale vote for a dead player)
        if(!victim || !victim.isAlive) return;
        dying.add(victim);

        // a victim takes their lover with them
        if(victim.lovePartner) {
            const lovePartner = game.players.find((player) => player.playerUUID === victim.lovePartner);
            if(!lovePartner) throw new Error(`Player with ${victim.lovePartner} does not exist, cannot be a love partner`);
            if(lovePartner.isAlive) dying.add(lovePartner);
        }
    });

    dying.forEach((player) => player.isAlive = false);

    // all deaths are final here (direct victims, lover chain, red lady):
    // a sheriff must not keep the badge in death
    clearDeadSheriff(game);

    return [...dying]
        .map((player) => player.playerUUID)
        .filter((playerUUID): playerUUID is string => playerUUID !== null);
}

/**
 * Resolve a night into deaths: the pack's victim (unless healed), the witch's poison
 * (unless the same player was healed), and the red lady's escape or host death.
 */
export const resolveNightDeaths = (game: Game, input: NightDeathInput): string[] => {
    let victims: string[] = [];

    // werewolf kill
    const werewolfVictimUUID = input.werewolfVictimUUID && !input.witchHeal ? input.werewolfVictimUUID : null;
    if(werewolfVictimUUID) victims.push(werewolfVictimUUID);

    // witch kill (healing and killing the same player must not kill them)
    const isHealedVictim = input.witchHeal && input.witchKillUUID !== null && input.witchKillUUID === input.werewolfVictimUUID;
    const witchKillTargetUUID = input.witchKillUUID && !isHealedVictim ? input.witchKillUUID : null;
    if(witchKillTargetUUID && !victims.includes(witchKillTargetUUID)) victims.push(witchKillTargetUUID);

    // red lady logic
    const redLady = game.players.find((player) => player.isAlive && player.role === Role.RED_LADY);
    if(redLady?.playerUUID) {
        // She escapes an attack aimed at her, and dies when her host was killed. She does NOT
        // escape the witch's poison - only the werewolves' attack - so a poisoned red lady dies
        // and the one-shot potion is not silently wasted.
        if(witchKillTargetUUID !== redLady.playerUUID) {
            victims = victims.filter((victim) => victim !== redLady.playerUUID);
            if(input.redLadySleepoverUUID && victims.includes(input.redLadySleepoverUUID)) {
                // Sleeping at a lover's place needs no special case: the lover cascade in
                // resolveDeaths kills her when the host is also her lover.
                victims.push(redLady.playerUUID);
            }
        }
    }

    return resolveDeaths(game, victims);
}
