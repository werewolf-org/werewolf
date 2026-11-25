import { Role } from "@shared/roles.js";
import { type Game, type Player } from "../../models.js";
import { getWerewolfVictimUUID } from "../selectors/night.selectors.js";

// every night target has to be a living player of this game
const getNightTarget = (game: Game, targetUUID: string, action: string): Player => {
    const target = game.players.find((player) => player.playerUUID === targetUUID);
    if(!target) throw new Error(`Player with UUID ${targetUUID} not found in Game ${game.gameId}, cannot ${action}`);
    if(!target.isAlive) throw new Error(`Player with UUID ${targetUUID} is already dead, cannot ${action}`);
    return target;
}

export const WerewolfHandler = {
    handleVote(game: Game, player: Player, targetUUID: string): boolean {
        const target = getNightTarget(game, targetUUID, "vote for this player");
        if(target === player) throw new Error(`Werewolf ${player.playerUUID} cannot vote for themselves`);

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
        if(player.nightAction?.revealUUID) throw new Error(`Seer ${player.playerUUID} already revealed a role this night`);
        // a seer may look at themselves; it is pointless but harmless
        const playerToSee = getNightTarget(game, revealUUID, "reveal the role of this player");
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
        if(firstPlayerUUID === secondPlayerUUID) throw new Error(`Player with UUID ${firstPlayerUUID} cannot be bound to themselves`);
        if(player.nightAction) throw new Error(`Cupid ${player.playerUUID} already bound lovers this night`);

        const firstPlayerInLove = getNightTarget(game, firstPlayerUUID, "bind this player as a lover");
        const secondPlayerInLove = getNightTarget(game, secondPlayerUUID, "bind this player as a lover");

        // Re-binding is rejected above, but a previous (possibly corrupted) bond must not survive
        // alongside the new pair, otherwise two couples could exist at once.
        game.players.forEach((p) => {
            if(p.lovePartner) {
                p.lovePartner = null;
                p.lovePartnerConfirmed = false;
            }
        });

        firstPlayerInLove.lovePartner = secondPlayerInLove.playerUUID;
        secondPlayerInLove.lovePartner = firstPlayerInLove.playerUUID;
        
        player.nightAction = { firstPlayerUUID: firstPlayerUUID, secondPlayerUUID: secondPlayerUUID };
        return false;
    },
    // * WARNING: here the player is not the cupid but the love partner
    handleLoverConfirmsBond(game: Game, player: Player): boolean {
        if(game.activeNightRole !== Role.CUPID) throw new Error(`Cannot confirm love bond in Game ${game.gameId} since active role is not CUPID (${game.activeNightRole})`);
        if(!player.isAlive) throw new Error(`Player ${player.playerUUID} is dead, so they cannot confirm the love bond`);
        if(!player.lovePartner) throw new Error(`Player ${player.playerUUID} in Game ${game.gameId} is not part of the love partners`);
        const lovePartner = game.players.find((p) => p.playerUUID === player.lovePartner);
        if(!lovePartner) throw new Error(`Player with UUID ${player.lovePartner} does not exist, cannot be a love partner`);

        player.lovePartnerConfirmed = true;
        // the bond is only confirmed once both lovers have confirmed
        return lovePartner.lovePartnerConfirmed;
    }
}

export const WitchHandler = {
    handlePotion(game: Game, player: Player, heal: boolean | null, killUUID: string | null): boolean {
        if(!heal && !killUUID) throw new Error(`Witch with ID ${player.playerUUID} didn't use a Potion`)

        const werewolfTargetUUID = getWerewolfVictimUUID(game);
        // the heal may already be recorded from an earlier call in the same night
        const healingTonight = !!heal || (player.nightAction?.heal ?? false);

        // validate everything before mutating, so a rejected request never burns a potion
        if(heal) {
            if(player.usedHealingPotion) throw new Error(`Witch in Game ${game.gameId} already used healing potion`);
            if(!werewolfTargetUUID) throw new Error(`There is no werewolf victim to heal in Game ${game.gameId}`);
        }
        let killTarget: Player | null = null;
        if(killUUID) {
            if(player.usedKillingPotion) throw new Error(`Witch in Game ${game.gameId} already used killing potion`) 
            killTarget = getNightTarget(game, killUUID, "poison this player");
            if(killTarget === player) throw new Error(`Witch ${player.playerUUID} cannot poison themselves`);
            if(healingTonight && killUUID === werewolfTargetUUID) throw new Error(`Witch ${player.playerUUID} cannot heal and kill the same player (${killUUID})`);
        }

        if(heal) {
            player.nightAction = {...player.nightAction, heal: heal }
            player.usedHealingPotion = true;
        }
        if(killTarget?.playerUUID) {
            player.nightAction = {...player.nightAction, killUUID: killTarget.playerUUID }
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
        if(!sleepoverUUID) throw new Error(`Red Lady ${player.playerUUID} did not choose a player to sleep over at`);
        const target = getNightTarget(game, sleepoverUUID, "sleep over at this player");
        if(target === player) throw new Error(`Red Lady ${player.playerUUID} cannot sleep over at their own place`);
        player.nightAction = { sleepoverUUID: sleepoverUUID };
        return true;
    }
}
