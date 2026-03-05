import { Role, ROLES } from "@shared/roles.js";
import type { Game, Player } from "../../models.js";
import { Phase } from "@shared/phases.js";

const getMostWerewolfVotes = (votes: string[]): string[] => {
    if (votes.length === 0) return [];
    const mapping: Record<string, number> = {};
    let maxCount = 0;
    let results: string[] = [];
    for (const str of votes) {
        const count = (mapping[str] || 0) + 1;
        mapping[str] = count;

        if (count > maxCount) {
        maxCount = count;
        }
    }
    for (const str in mapping) {
        if (mapping[str] === maxCount) {
        results.push(str);
        }
    }
    return results;
}

export const getWerewolfVotes = (game: Game): Record<string, string> | null => {
    const votes = game.players
        .filter(p => p.isAlive && p.role === Role.WEREWOLF && p.nightAction)
        .reduce((acc, werewolf) => {
        const werewolfId = werewolf.playerUUID;
        const targetUUID = (werewolf.nightAction as Record<string, any>)?.targetUUID;
        if (werewolfId && targetUUID) acc[werewolfId] = targetUUID;
        return acc
        }, {} as Record<string, string>)
    return Object.keys(votes).length > 0 ? votes : null
}

export const getWerewolfVictimUUID = (game: Game): string | null => {
    const aliveWerewolves = game.players.filter((players) => players.isAlive == true && players.role === Role.WEREWOLF);
    if(aliveWerewolves.find((werewolf) => !werewolf.nightAction)) return null;
    const werewolfVotes = aliveWerewolves.map((werewolf) => (werewolf.nightAction as Record<string, any>).targetUUID ?? '');
    const mostVoted = getMostWerewolfVotes(werewolfVotes);
    const werewolfTargetUUID: string | null = (mostVoted.length === 1 && mostVoted[0] && mostVoted[0] != '') ? mostVoted[0] : null;
    return werewolfTargetUUID;
}

export const getNextToWakeUp = (game: Game, first: boolean): Role | null => {
    const rolesInGame = new Set(game.players.filter(p => p.isAlive).map(p => p.role));

    // Determine the order of roles that wake up this night
    const wakeOrder = (Object.keys(ROLES) as Role[])
        .filter(role => {
            const def = ROLES[role];
            const isRoleInGame = rolesInGame.has(role);
            const isFirstNightOnly = def.onlyFirstNight;
            const isFirstNight = game.round === 0;

            return def.wakesUp && isRoleInGame && (!isFirstNightOnly || isFirstNight);
        })
        .sort((a, b) => ROLES[a].nightOrder - ROLES[b].nightOrder);

    if(first) return wakeOrder[0] ?? null;

    const currentIndex = game.activeNightRole ? wakeOrder.indexOf(game.activeNightRole) : 0;
    const nextActiveRole = wakeOrder[currentIndex + 1];
    return nextActiveRole ?? null;
}

// if role === null: Role does not matter
// e.g. in Cupid phase also non cupid players do actions (lovePartnerConfirms)
export const checkPlayerNightRole = (game: Game, player: Player, role: Role | null): void => {
    if(game.phase !== Phase.NIGHT) throw new Error(`Game ${game.gameId} is not current in Night Phase, cannot do Night Action!`);
    if(!role) return;

    // check if player exists & has correct role
    if(player.role !== role) throw new Error(`Player with UUID ${player.playerUUID} does not have the correct role to do the night action of the role (${player.role} !== ${role})`);
    if(ROLES[player.role].wakesUp === false) throw new Error(`Player ${player.playerUUID} has role ${player.role}, but it doesnt wake up in the night`);
}