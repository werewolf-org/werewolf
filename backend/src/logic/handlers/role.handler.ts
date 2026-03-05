import { Role } from "@shared/roles.js";
import { type Game, type Player } from "../../models.js";

export const WerewolfHandler = {
    handleVote(game: Game, player: Player, targetUUID: string): boolean {
        // send vote to all werewolves
        const aliveWerewolves = game.players.filter((player) => player.isAlive === true && player.role === Role.WEREWOLF)
        aliveWerewolves.forEach((werewolfPlayer) => {
            if(!werewolfPlayer.socketId) throw new Error(`Player ${player.playerUUID} does not have a socketId`);
        })
        player.nightAction = { targetUUID: targetUUID };

        //check if everyone Voted
        const wolvesWithoutVotes = aliveWerewolves.filter((werewolf) => !werewolf.nightAction)
        if (!wolvesWithoutVotes || wolvesWithoutVotes.length === 0) return true;
        return false;
    }
}

export const SeerHandler = {
    handleRevealingRole(game: Game, player: Player, revealUUID: string): boolean {
        // TODO Security: check if seer has already seen this night
        const playerToSee = game.players.find((player) => player.playerUUID === revealUUID);
        if(!playerToSee) throw new Error(`Player with UUID ${revealUUID} not found, cannot see this players role`);
        if(!playerToSee.role) throw new Error(`Player with UUID ${revealUUID} does not have a role`);
        player.nightAction = { revealUUID: revealUUID, revealedRole: playerToSee.role };
        return false;
    },
    handleConfirm(game: Game): boolean {
        return true;
    }
}

export const CupidHandler = {
    handleBindLovers(game: Game, player: Player, firstPlayerUUID: string, secondPlayerUUID: string): boolean {
        if(game.round && game.round > 0) throw new Error(`Game ${game.gameId} is already in round ${game.round}, so cupid cannot do action`)
        
        const firstPlayerInLove = game.players.find((player) => player.playerUUID === firstPlayerUUID);
        const secondPlayerInLove = game.players.find((player) => player.playerUUID === secondPlayerUUID);
        if(!firstPlayerInLove) throw new Error(`Player with ID ${firstPlayerUUID} not found`);
        if(!secondPlayerInLove) throw new Error(`Player with ID ${secondPlayerUUID} not found`);
        firstPlayerInLove.lovePartner = secondPlayerInLove.playerUUID;
        secondPlayerInLove.lovePartner = firstPlayerInLove.playerUUID;
        
        player.nightAction = { firstPlayerUUID: firstPlayerUUID, secondPlayerUUID: secondPlayerUUID };
        return false;
    },
    // * WARNING: here the player is not the cupid but the love partner
    handleLoverConfirmsBond(game: Game, player: Player): boolean {
        if(game.activeNightRole !== Role.CUPID) throw new Error(`Cannot confirm love bond in Game ${game.gameId} since active role is not CUPID (${game.activeNightRole})`);
        const lovePartners = game.players.filter((player) => player.lovePartner);
        if(!lovePartners.find((partner) => partner === player)) throw new Error(`Player ${player.playerUUID} in Game ${game.gameId} is not part of the love partners`);
        player.lovePartnerConfirmed = true;
        if(lovePartners.filter((partner) => partner.lovePartnerConfirmed).length >= 2) return true;
        return false;
    }
}

export const WitchHandler = {
    handlePotion(game: Game, player: Player, heal: boolean | null, killUUID: string | null): boolean {
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
        return false;
    },
    handleConfirm(game: Game, player: Player): boolean {
        return true;
    }
}

export const RedLadyHandler = {
    handleSleepover(game: Game, player: Player, sleepoverUUID: string): boolean {
        player.nightAction = { sleepoverUUID: sleepoverUUID };
        return true;
    }
}