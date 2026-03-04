import { Role, ROLES } from "@shared/roles.js";
import { type Game, type Player } from "../models.js";
import { Phase } from "@shared/phases.js";

export const nextRole = (game: Game) => {
    const rolesInGame = new Set(game.players.filter(p => p.isAlive).map(p => p.role));

    // TODO Refactor: use same logic as in game.manager (DUPLICATE LOGIC)
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

    // Find where we are in the sequence
    const currentIndex = game.activeNightRole ? wakeOrder.indexOf(game.activeNightRole) : 0;
    const nextActiveRole = wakeOrder[currentIndex + 1];

    if (nextActiveRole) {
        // Advance to the next role
        game.activeNightRole = nextActiveRole;
    } else {
        // End of Night -> Start Day or Sheriff Election
        game.activeNightRole = null;
        game.lynchDone = false;
        
        if (game.round === 0) {
            game.phase = Phase.SHERIFF_ELECTION;
        } else {
            game.phase = Phase.DAY;
        }

        resolveNightActions(game);

        game.players.forEach((player) => player.nightAction = null);
    }
};

// TODO: put to utils
export const getMostVotes = (votes: string[]): string[] => {
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

export const getWerewolfVictimUUID = (game: Game) => {
    const aliveWerewolves = game.players.filter((players) => players.isAlive == true && players.role === Role.WEREWOLF);
    if(aliveWerewolves.find((werewolf) => !werewolf.nightAction)) return null;
    const werewolfVotes = aliveWerewolves.map((werewolf) => (werewolf.nightAction as Record<string, any>).targetUUID ?? '');
    const mostVoted = getMostVotes(werewolfVotes);
    const werewolfTargetUUID: string | null = (mostVoted.length === 1 && mostVoted[0] && mostVoted[0] != '') ? mostVoted[0] : null;
    return werewolfTargetUUID;
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

export const resolveNightActions = (game: Game) => {
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

    // couple dying
    dyingPlayerUUIDs.forEach((playerUUID) => checkCoupleDying(game, playerUUID));

    // TODO: edge case - what if the red lady sleeps at the love partner's place

    game.players.forEach((player) => {
        if(player.playerUUID && dyingPlayerUUIDs.includes(player.playerUUID)) player.isAlive = false;
    });
    game.players.forEach((player) => {
        player.nightAction = null;
    });
}

export const checkCoupleDying = (game: Game, dyingUUID: string | null) => {
    if(!dyingUUID) return;
    const lovePartnerUUID = game.players.find((player) => player.playerUUID === dyingUUID)?.lovePartner;
    if(!lovePartnerUUID) return;
    const lovePartner = game.players.find((player) => player.playerUUID === lovePartnerUUID);
    if(!lovePartner) throw new Error(`Player with ${lovePartnerUUID} does not exist, cannot be a love partner`);
    lovePartner.isAlive = false;
    return lovePartnerUUID;
}

export const WerewolfHandler = {
    handleVote(game: Game, player: Player, targetUUID: string): void {
        // send vote to all werewolves
        const aliveWerewolves = game.players.filter((player) => player.isAlive === true && player.role === Role.WEREWOLF)
        aliveWerewolves.forEach((werewolfPlayer) => {
            if(!werewolfPlayer.socketId) throw new Error(`Player ${player.playerUUID} does not have a socketId`);
        })
        player.nightAction = { targetUUID: targetUUID };

        //check if everyone Voted
        const wolvesWithoutVotes = aliveWerewolves.filter((werewolf) => !werewolf.nightAction)
        if (!wolvesWithoutVotes || wolvesWithoutVotes.length === 0) {
            nextRole(game);
        }
    }
}

export const SeerHandler = {
    handleRevealingRole(game: Game, player: Player, revealUUID: string): void {
        // TODO Security: check if seer has already seen this night
        const playerToSee = game.players.find((player) => player.playerUUID === revealUUID);
        if(!playerToSee) throw new Error(`Player with UUID ${revealUUID} not found, cannot see this players role`);
        if(!playerToSee.role) throw new Error(`Player with UUID ${revealUUID} does not have a role`);
        player.nightAction = { revealUUID: revealUUID, revealedRole: playerToSee.role };
    },
    handleConfirm(game: Game) {
        nextRole(game);
    }
}

export const CupidHandler = {
    handleBindLovers(game: Game, player: Player, firstPlayerUUID: string, secondPlayerUUID: string): void {
        if(game.round && game.round > 0) throw new Error(`Game ${game.gameId} is already in round ${game.round}, so cupid cannot do action`)
        
        const firstPlayerInLove = game.players.find((player) => player.playerUUID === firstPlayerUUID);
        const secondPlayerInLove = game.players.find((player) => player.playerUUID === secondPlayerUUID);
        if(!firstPlayerInLove) throw new Error(`Player with ID ${firstPlayerUUID} not found`);
        if(!secondPlayerInLove) throw new Error(`Player with ID ${secondPlayerUUID} not found`);
        firstPlayerInLove.lovePartner = secondPlayerInLove.playerUUID;
        secondPlayerInLove.lovePartner = firstPlayerInLove.playerUUID;
        
        player.nightAction = { firstPlayerUUID: firstPlayerUUID, secondPlayerUUID: secondPlayerUUID };
    },
    // * WARNING: here the player is not the cupid but the love partner
    handleLoverConfirmsBond(game: Game, player: Player) {
        if(game.activeNightRole !== Role.CUPID) throw new Error(`Cannot confirm love bond in Game ${game.gameId} since active role is not CUPID (${game.activeNightRole})`);
        const lovePartners = game.players.filter((player) => player.lovePartner);
        if(!lovePartners.find((partner) => partner === player)) throw new Error(`Player ${player.playerUUID} in Game ${game.gameId} is not part of the love partners`);
        player.lovePartnerConfirmed = true;
        if(lovePartners.filter((partner) => partner.lovePartnerConfirmed).length >= 2) nextRole(game);
    }
}

export const WitchHandler = {
    handlePotion(game: Game, player: Player, heal: boolean | null, killUUID: string | null) {
        if(!heal && !killUUID) throw new Error(`Witch with ID ${player.playerUUID} didn't use a Potion`)

        if(heal) {
            if(player.usedHealingPotion) throw new Error(`Witch in Game ${game.gameId} already used healing potion`);
            if(!player.nightAction) player.nightAction = { heal: heal }
            else player.nightAction = {...player.nightAction, heal: heal }
            player.usedHealingPotion = true;
        }
        if(killUUID) {
            if(player.usedKillingPotion) throw new Error(`Witch in Game ${game.gameId} already used killing potion`) 
            if(!player.nightAction) player.nightAction = { killUUID: killUUID }
            else player.nightAction = {...player.nightAction, killUUID: killUUID }
            player.usedKillingPotion = true;
        }
    },
    handleConfirm(game: Game, player: Player) {
        nextRole(game);
    }
}

export const RedLadyHandler = {
    handleSleepover(game: Game, player: Player, sleepoverUUID: string): void {
        player.nightAction = { sleepoverUUID: sleepoverUUID };
        nextRole(game);
    }
}