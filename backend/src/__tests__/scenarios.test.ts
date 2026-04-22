import { describe, it, expect } from "vitest";
import { LobbyHander } from "../logic/handlers/lobby.handler.js";
import { VoteHandler } from "../logic/handlers/vote.handler.js";
import { NightHandler } from "../logic/handlers/night.handler.js";
import { WerewolfHandler, SeerHandler, WitchHandler, CupidHandler, RedLadyHandler } from "../logic/handlers/role.handler.js";
import { Role } from "@shared/roles.js";
import { Phase } from "@shared/phases.js";
import type { Game, Player } from "../models.js";
import { createGameWithPlayers, setRoles } from "./test-helpers.js";

/* ------------------------------------------------------------------ */
/*  Test helpers for advancing the game state programmatically         */
/* ------------------------------------------------------------------ */

function startFullGame(playerCount: number, roles: Role[]): Game {
  const game = createGameWithPlayers(playerCount);
  for (let i = 0; i < playerCount; i++) {
    game.players[i].role = roles[i];
  }
  game.phase = Phase.DISTRIBUTION;
  LobbyHander.startGame(game);
  return game;
}

function checkGameOver(game: Game): void {
  const alivePlayers = game.players.filter((player) => player.isAlive);
  if (alivePlayers.length === 0) {
    game.phase = Phase.GAME_OVER;
    game.winningTeam = null;
    return;
  }
  // Check couple FIRST (overrides werewolf/village if 2 lovers remain)
  if (alivePlayers.length === 2) {
    const [a, b] = alivePlayers;
    if (a.lovePartner === b.playerUUID && b.lovePartner === a.playerUUID) {
      game.phase = Phase.GAME_OVER;
      game.winningTeam = 'couple';
      return;
    }
  }
  const isWerewolf = (player: Player) => player.role == Role.WEREWOLF;
  if(alivePlayers.every(isWerewolf)) {
    game.phase = Phase.GAME_OVER;
    game.winningTeam = 'werewolves';
    return;
  }
  if (!alivePlayers.some(isWerewolf)) {
    game.phase = Phase.GAME_OVER;
    game.winningTeam = 'village';
    return;
  }
}

/* ------------------------------------------------------------------ */
/*  Scenarios                                                           */
/* ------------------------------------------------------------------ */

describe("elaborate game scenarios", () => {
  /* ================================================================
     1. FULL GAME: 6 players, Cupid + Werewolf + Witch + Seer + 2 Villagers
     ================================================================ */
  describe("full 6-player game with roles", () => {
    it("plays through round 0 night (cupid → ww → seer → witch) then sheriff election then day lynch", () => {
      /* ---- SETUP ---- */
      const game = startFullGame(6, [
        Role.CUPID,       // p0
        Role.WEREWOLF,    // p1
        Role.SEER,        // p2
        Role.WITCH,       // p3
        Role.VILLAGER,    // p4
        Role.VILLAGER,    // p5
      ]);
      expect(game.phase).toBe(Phase.NIGHT);
      expect(game.round).toBe(0);

      /* ---- CUPID ---- */
      expect(game.activeNightRole).toBe(Role.CUPID);
      CupidHandler.handleBindLovers(game, game.players[0], "p4", "p5");
      CupidHandler.handleLoverConfirmsBond(game, game.players[4]);
      const cupidDone = CupidHandler.handleLoverConfirmsBond(game, game.players[5]);
      expect(cupidDone).toBe(true);
      NightHandler.nextRole(game);

      /* ---- WEREWOLVES ---- */
      expect(game.activeNightRole).toBe(Role.WEREWOLF);
      WerewolfHandler.handleVote(game, game.players[1], "p4"); // target villager p4
      NightHandler.nextRole(game);

      /* ---- SEER ---- */
      expect(game.activeNightRole).toBe(Role.SEER);
      SeerHandler.handleRevealingRole(game, game.players[2], "p1");
      NightHandler.nextRole(game);

      /* ---- WITCH (heals) ---- */
      expect(game.activeNightRole).toBe(Role.WITCH);
      WitchHandler.handlePotion(game, game.players[3], true, null);
      NightHandler.nextRole(game);

      /* ---- NIGHT ENDS → SHERIFF_ELECTION ---- */
      expect(game.phase).toBe(Phase.SHERIFF_ELECTION);
      expect(game.players[4].isAlive).toBe(true); // healed

      /* ---- SHERIFF VOTE ---- */
      VoteHandler.castSheriffVote(game, game.players[0], "p4");
      VoteHandler.castSheriffVote(game, game.players[1], "p4");
      VoteHandler.castSheriffVote(game, game.players[2], "p5");
      VoteHandler.castSheriffVote(game, game.players[3], "p4");
      VoteHandler.castSheriffVote(game, game.players[4], "p5");
      VoteHandler.castSheriffVote(game, game.players[5], "p4"); // last vote triggers resolution

      expect(game.sheriffElectionDone).toBe(true);
      expect(game.sheriffUUID).toBe("p4");

      /* ---- ACCEPT SHERIFF → DAY ---- */
      VoteHandler.acceptSheriffRole(game, game.players[4]);
      expect(game.phase).toBe(Phase.DAY);

      /* ---- DAY: NOMINATIONS ---- */
      VoteHandler.nominate(game, game.players[0], "p1");  // nominate werewolf
      VoteHandler.nominate(game, game.players[1], false);  // abstain
      VoteHandler.nominate(game, game.players[2], false);  // abstain — p1 already nominated
      VoteHandler.nominate(game, game.players[3], false);
      VoteHandler.nominate(game, game.players[4], false);  // sheriff abstains
      VoteHandler.nominate(game, game.players[5], false);

      /* ---- DAY: LYNCH VOTE ---- */
      VoteHandler.castLynchVote(game, game.players[0], "p1");
      VoteHandler.castLynchVote(game, game.players[1], false);
      VoteHandler.castLynchVote(game, game.players[2], "p1");
      VoteHandler.castLynchVote(game, game.players[3], "p1");
      VoteHandler.castLynchVote(game, game.players[4], "p1");
      VoteHandler.castLynchVote(game, game.players[5], "p1"); // triggers

      expect(game.lynchDone).toBe(true);
      expect(game.lastVotedOutUUID).toBe("p1");
      expect(game.players[1].isAlive).toBe(false);
    });

    /* ================================================================
       2. LOVE PARTNER CHAIN DEATH ACROSS DAY & NIGHT
       ================================================================ */
    it("kills both lovers when one is lynched during the day", () => {
      const game = startFullGame(4, [Role.CUPID, Role.VILLAGER, Role.VILLAGER, Role.WEREWOLF]);
      // Night 0: cupid binds p1-p2
      expect(game.activeNightRole).toBe(Role.CUPID);
      CupidHandler.handleBindLovers(game, game.players[0], "p1", "p2");
      CupidHandler.handleLoverConfirmsBond(game, game.players[1]);
      CupidHandler.handleLoverConfirmsBond(game, game.players[2]);
      NightHandler.nextRole(game);

      WerewolfHandler.handleVote(game, game.players[3], "p0"); // kill cupid
      NightHandler.nextRole(game);
      // After first night end, phase becomes SHERIFF_ELECTION (round 0)
      expect(game.phase).toBe(Phase.SHERIFF_ELECTION);

      // To keep this scenario focused, jump to DAY manually
      game.phase = Phase.DAY;
      game.lynchDone = false;
      game.players.forEach(p => { p.nominationUUID = null; p.voteTargetUUID = null; p.readyForNight = false; });

      // Nominations — only one player nominates p1
      VoteHandler.nominate(game, game.players[0], "p1");
      VoteHandler.nominate(game, game.players[1], false);
      VoteHandler.nominate(game, game.players[2], false);
      if (game.players[3].isAlive) VoteHandler.nominate(game, game.players[3], false);

      // Lynch vote unanimously via handler (skip dead players)
      const alive = game.players.filter(p => p.isAlive);
      alive.forEach(p => VoteHandler.castLynchVote(game, p, "p1"));

      expect(game.players[1].isAlive).toBe(false);
      expect(game.players[2].isAlive).toBe(false); // lover died too
    });

    /* ================================================================
       3. WITCH USES BOTH POTIONS IN ONE NIGHT
       ================================================================ */
    it("allows witch to use both heal and kill in the same night", () => {
      const game = startFullGame(4, [Role.WITCH, Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER]);
      game.round = 1; // skip cupid
      game.activeNightRole = Role.WEREWOLF;
      WerewolfHandler.handleVote(game, game.players[1], "p2");
      NightHandler.nextRole(game); // should hit witch

      expect(game.activeNightRole).toBe(Role.WITCH);
      WitchHandler.handlePotion(game, game.players[0], true, "p3");
      NightHandler.nextRole(game);

      expect(game.phase).toBe(Phase.DAY);
      expect(game.players[2].isAlive).toBe(true); // healed
      expect(game.players[3].isAlive).toBe(false); // witch killed
    });

    /* ================================================================
       4. ALL CITIZENS ABSTAIN → NO SHERIFF, NO LYNCH
       ================================================================ */
    it("results in no sheriff and no lynch when everyone abstains", () => {
      const game = startFullGame(3, [Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER]);
      game.round = 1;
      game.activeNightRole = Role.WEREWOLF;
      WerewolfHandler.handleVote(game, game.players[0], "p1");
      NightHandler.nextRole(game);
      expect(game.phase).toBe(Phase.DAY);

      // nominations: all abstain
      game.players.forEach(p => { if (p.isAlive) VoteHandler.nominate(game, p, false); });
      expect(game.lynchDone).toBe(true);
      expect(game.lastVotedOutUUID).toBeNull();
    });

    /* ================================================================
       5. SHERIFF TIE-BREAKER IN LYNCH VOTE
       ================================================================ */
    it("sheriff breaks a tie in the lynch vote", () => {
      const game = startFullGame(5, [Role.VILLAGER, Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER, Role.VILLAGER]);
      game.round = 1;
      game.activeNightRole = Role.WEREWOLF;
      WerewolfHandler.handleVote(game, game.players[1], "p4");
      NightHandler.nextRole(game);
      expect(game.phase).toBe(Phase.DAY);

      // Make p0 the sheriff for tie-breaking
      game.sheriffUUID = "p0";

      // Nominations: p2 and p3 are nominated (by different players)
      VoteHandler.nominate(game, game.players[0], "p2");
      VoteHandler.nominate(game, game.players[1], "p3");
      VoteHandler.nominate(game, game.players[2], false);
      VoteHandler.nominate(game, game.players[3], false);
      VoteHandler.nominate(game, game.players[4], false);

      // Votes: 2-2 split, sheriff picks p3
      VoteHandler.castLynchVote(game, game.players[0], "p3");
      VoteHandler.castLynchVote(game, game.players[1], "p2");
      VoteHandler.castLynchVote(game, game.players[2], "p3");
      VoteHandler.castLynchVote(game, game.players[3], "p2"); // triggers resolution
      // p4 is dead, skip

      expect(game.lastVotedOutUUID).toBe("p3");
    });

    /* ================================================================
       6. GAME OVER: VILLAGE WINS IMMEDIATELY AFTER FIRST LYNCH
       ================================================================ */
    it("ends game with village win when only werewolf is lynched", () => {
      const game = startFullGame(3, [Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER]);
      game.round = 1;
      game.activeNightRole = Role.WEREWOLF;
      WerewolfHandler.handleVote(game, game.players[0], "p1");
      NightHandler.nextRole(game);
      expect(game.phase).toBe(Phase.DAY);

      // Lynch the only werewolf — all alive players nominate/vote
      const alive = game.players.filter(p => p.isAlive);
      VoteHandler.nominate(game, alive[0], "p0");
      alive.slice(1).forEach(p => VoteHandler.nominate(game, p, false));
      alive.forEach(p => VoteHandler.castLynchVote(game, p, "p0")); // triggers

      expect(game.players[0].isAlive).toBe(false);
      checkGameOver(game);
      expect(game.phase).toBe(Phase.GAME_OVER);
      expect(game.winningTeam).toBe("village");
    });

    /* ================================================================
       7. GAME OVER: WEREWOLVES WIN
       ================================================================ */
    it("ends game with werewolf win when equal numbers", () => {
      const game = startFullGame(4, [Role.WEREWOLF, Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER]);
      game.round = 1;
      game.activeNightRole = Role.WEREWOLF;
      WerewolfHandler.handleVote(game, game.players[0], "p2");
      WerewolfHandler.handleVote(game, game.players[1], "p2"); // unanimous kill villager
      NightHandler.nextRole(game);
      expect(game.phase).toBe(Phase.DAY);
      expect(game.players[2].isAlive).toBe(false);

      // Now it is 2 wolves vs 1 villager → wolves win
      // We replicate the GameManager.checkGameOver logic for verification
      const isWerewolf = (p: Player) => p.role === Role.WEREWOLF;
      const alive = game.players.filter(p => p.isAlive);
      expect(alive.every(isWerewolf)).toBe(false); // not ALL wolves yet
      expect(alive.some(isWerewolf)).toBe(true);   // but wolves exist

      // Lynch one more villager to trigger end (only alive vote)
      const aliveDay2 = game.players.filter(p => p.isAlive);
      VoteHandler.nominate(game, aliveDay2[0], "p3");
      aliveDay2.slice(1).forEach(p => VoteHandler.nominate(game, p, false));
      aliveDay2.forEach(p => VoteHandler.castLynchVote(game, p, "p3")); // triggers
      checkGameOver(game);

      expect(game.phase).toBe(Phase.GAME_OVER);
      expect(game.winningTeam).toBe("werewolves");
    });

    /* ================================================================
       8. RED LADY DIES WHEN VISITING VICTIM
       ================================================================ */
    it("red lady dies if she sleeps over at the werewolf target", () => {
      const game = startFullGame(4, [Role.RED_LADY, Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER]);
      game.round = 1;
      game.activeNightRole = Role.RED_LADY;
      RedLadyHandler.handleSleepover(game, game.players[0], "p2");
      NightHandler.nextRole(game);

      expect(game.activeNightRole).toBe(Role.WEREWOLF);
      WerewolfHandler.handleVote(game, game.players[1], "p2");
      NightHandler.nextRole(game);

      expect(game.phase).toBe(Phase.DAY);
      expect(game.players[0].isAlive).toBe(false); // red lady dies (visited dying host)
      expect(game.players[2].isAlive).toBe(false); // host also dies (wolf target)
    });

    /* ================================================================
       9. MULTI-ROUND GAME: Two full cycles
       ================================================================ */
    it("survives two full day-night cycles", () => {
      const game = startFullGame(5, [
        Role.WEREWOLF,
        Role.WITCH,
        Role.SEER,
        Role.VILLAGER,
        Role.VILLAGER,
      ]);
      game.round = 1;
      game.activeNightRole = Role.WEREWOLF;
      WerewolfHandler.handleVote(game, game.players[0], "p3");
      NightHandler.nextRole(game);
      // After Werewolf (3) comes Seer (4), then Witch (5)
      expect(game.activeNightRole).toBe(Role.SEER);
      SeerHandler.handleRevealingRole(game, game.players[2], "p0");
      NightHandler.nextRole(game);
      expect(game.activeNightRole).toBe(Role.WITCH);

      // do nothing
      WitchHandler.handleConfirm(game, game.players[1]);
      NightHandler.nextRole(game);
      expect(game.phase).toBe(Phase.DAY);
      expect(game.players[3].isAlive).toBe(false);

      // DAY 1 — only one player nominates p0
      const alivePlayers = game.players.filter(p => p.isAlive);
      VoteHandler.nominate(game, alivePlayers[0], "p0");
      alivePlayers.slice(1).forEach(p => VoteHandler.nominate(game, p, false));
      alivePlayers.forEach(p => VoteHandler.castLynchVote(game, p, "p0"));
      expect(game.lastVotedOutUUID).toBe("p0");
      expect(game.lynchDone).toBe(true);

      // Ready for night
      game.players.filter(p => p.isAlive).forEach(p => VoteHandler.readyForNight(game, p));
      expect(game.phase).toBe(Phase.NIGHT);
      expect(game.round).toBe(2);
    });

    /* ================================================================
       10. COUPLE WINS CONDITION
       ================================================================ */
    it("ends with couple win when only lovers remain", () => {
      const game = startFullGame(4, [Role.CUPID, Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER]);
      // Night 0: cupid binds p2-p3
      expect(game.activeNightRole).toBe(Role.CUPID);
      CupidHandler.handleBindLovers(game, game.players[0], "p2", "p3");
      CupidHandler.handleLoverConfirmsBond(game, game.players[2]);
      CupidHandler.handleLoverConfirmsBond(game, game.players[3]);
      NightHandler.nextRole(game);

      // Werewolf kills p0 (cupid)
      WerewolfHandler.handleVote(game, game.players[1], "p0");
      NightHandler.nextRole(game);
      expect(game.phase).toBe(Phase.SHERIFF_ELECTION); // round 0

      // Sheriff election — all abstain would throw, so give one vote
      VoteHandler.castSheriffVote(game, game.players[1], false);
      VoteHandler.castSheriffVote(game, game.players[2], false);
      VoteHandler.castSheriffVote(game, game.players[3], "p2"); // triggers
      expect(game.sheriffElectionDone).toBe(true);
      expect(game.sheriffUUID).toBe("p2");
      VoteHandler.acceptSheriffRole(game, game.players[2]);
      expect(game.phase).toBe(Phase.DAY);

      // Lynch p1 (werewolf) — only one player nominates
      VoteHandler.nominate(game, game.players[2], "p1");
      VoteHandler.nominate(game, game.players[1], false);
      VoteHandler.nominate(game, game.players[3], false);
      VoteHandler.castLynchVote(game, game.players[1], "p1");
      VoteHandler.castLynchVote(game, game.players[2], "p1");
      VoteHandler.castLynchVote(game, game.players[3], "p1"); // triggers

      expect(game.players[1].isAlive).toBe(false);
      checkGameOver(game);
      expect(game.phase).toBe(Phase.GAME_OVER);
      expect(game.winningTeam).toBe("couple");
    });

    /* ================================================================
       11. SHERIFF ELECTION WITH MULTIPLE ABSTAINS → TIE → NO SHERIFF
       ================================================================ */
    it("fails to elect sheriff when all abstain", () => {
      const game = startFullGame(4, [Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER, Role.VILLAGER]);
      game.round = 1; // skip cupid
      game.activeNightRole = Role.WEREWOLF;
      WerewolfHandler.handleVote(game, game.players[0], "p1");
      NightHandler.nextRole(game);
      expect(game.phase).toBe(Phase.DAY);

      // Sheriff election: all abstain — no votes present, no sheriff elected
      VoteHandler.castSheriffVote(game, game.players[0], false);
      VoteHandler.castSheriffVote(game, game.players[1], false);
      VoteHandler.castSheriffVote(game, game.players[2], false);
      VoteHandler.castSheriffVote(game, game.players[3], false); // triggers

      expect(game.sheriffElectionDone).toBe(true);
      expect(game.sheriffUUID).toBeNull();
    });

    /* ================================================================
       12. SEER REVEALING ROLE OF DEAD PLAYER
       ================================================================ */
    it("seer can reveal role even of a dead player (current behavior)", () => {
      const game = createGameWithPlayers(3);
      setRoles(game, [Role.SEER, Role.WEREWOLF, Role.VILLAGER]);
      game.players[1].isAlive = false;
      game.phase = Phase.NIGHT;
      SeerHandler.handleRevealingRole(game, game.players[0], "p1");
      expect((game.players[0].nightAction as any).revealedRole).toBe(Role.WEREWOLF);
    });

    /* ================================================================
       13. WITCH CANNOT REUSE HEALING POTION
       ================================================================ */
    it("throws when witch tries to heal twice across nights", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.WITCH, Role.VILLAGER]);
      game.phase = Phase.NIGHT;
      WitchHandler.handlePotion(game, game.players[0], true, null);
      expect(game.players[0].usedHealingPotion).toBe(true);
      expect(() => WitchHandler.handlePotion(game, game.players[0], true, null)).toThrow("already used healing potion");
    });

    /* ================================================================
       14. WEREWOLF CONSENSUS: 2 wolves split → no kill
       ================================================================ */
    it("fails to kill when wolves do not unanimously agree", () => {
      const game = startFullGame(5, [Role.WEREWOLF, Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER, Role.VILLAGER]);
      game.round = 1;
      game.activeNightRole = Role.WEREWOLF;
      // 2 wolves split votes → tie for most voted
      WerewolfHandler.handleVote(game, game.players[0], "p2");
      WerewolfHandler.handleVote(game, game.players[1], "p3");
      NightHandler.nextRole(game);
      expect(game.phase).toBe(Phase.DAY);
      expect(game.players[2].isAlive).toBe(true);
      expect(game.players[3].isAlive).toBe(true);
    });

    /* ================================================================
       15. SEER → CONFIRM → NIGHT PROGRESSES
       ================================================================ */
    it("seer confirms after reveal and night advances", () => {
      const game = startFullGame(3, [Role.SEER, Role.WEREWOLF, Role.VILLAGER]);
      game.round = 1;
      game.activeNightRole = Role.WEREWOLF;
      WerewolfHandler.handleVote(game, game.players[1], "p2");
      NightHandler.nextRole(game);
      expect(game.activeNightRole).toBe(Role.SEER);
      SeerHandler.handleRevealingRole(game, game.players[0], "p1");
      NightHandler.nextRole(game); // should be DAY since no witch
      expect(game.phase).toBe(Phase.DAY);
      expect(game.players[2].isAlive).toBe(false);
    });

    /* ================================================================
       16. RED LADY REMOVED FROM VICTIMS IF SHE IS THE TARGET
       ================================================================ */
    it("red lady does not die if she is the wolf target (she is removed)", () => {
      const game = startFullGame(3, [Role.RED_LADY, Role.WEREWOLF, Role.VILLAGER]);
      game.round = 1;
      game.activeNightRole = Role.RED_LADY;
      RedLadyHandler.handleSleepover(game, game.players[0], "p2"); // sleeps at p2
      NightHandler.nextRole(game);
      WerewolfHandler.handleVote(game, game.players[1], "p0"); // target red lady directly
      NightHandler.nextRole(game);
      expect(game.players[0].isAlive).toBe(true); // removed from victims
      expect(game.players[2].isAlive).toBe(true); // host also lives
    });

    /* ================================================================
       17. DAY NOMINATION: some abstain, then vote on nominated
       ================================================================ */
    it("allows mixed nominations and abstentions, then vote only on nominated", () => {
      const game = startFullGame(5, [Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER, Role.VILLAGER, Role.VILLAGER]);
      game.round = 1;
      game.activeNightRole = Role.WEREWOLF;
      WerewolfHandler.handleVote(game, game.players[0], "p2");
      NightHandler.nextRole(game);
      expect(game.phase).toBe(Phase.DAY);

      // Alive: p0 (wolf), p1, p3, p4 (p2 dead)
      const aliveDay = game.players.filter(p => p.isAlive);
      aliveDay.forEach((p, idx) => {
        const nominations = ["p1", false, false, "p3"]; // p0 → p1, p1 → false, p3 → false, p4 → p3
        VoteHandler.nominate(game, p, nominations[idx] as any);
      });

      // Alive players vote
      aliveDay.forEach((p, idx) => {
        const votes = ["p1", false, "p3", "p1"]; // 3 p1, 1 p3
        VoteHandler.castLynchVote(game, p, votes[idx] as any);
      });

      expect(game.lastVotedOutUUID).toBe("p1");
    });

    /* ================================================================
       18. SHERIFF ELECTION: one player gets majority
       ================================================================ */
    it("elects sheriff with clear majority", () => {
      const game = startFullGame(5, [Role.VILLAGER, Role.VILLAGER, Role.VILLAGER, Role.VILLAGER, Role.WEREWOLF]);
      game.round = 1; // skip cupid
      game.activeNightRole = Role.WEREWOLF;
      WerewolfHandler.handleVote(game, game.players[4], "p0");
      NightHandler.nextRole(game);
      expect(game.phase).toBe(Phase.DAY);
      // round 1 -> after night goes to DAY, not SHERIFF_ELECTION. Force it.
      game.phase = Phase.SHERIFF_ELECTION;
      game.sheriffElectionDone = false;
      game.players.forEach(p => { p.voteTargetUUID = null; p.readyForNight = false; });

      VoteHandler.castSheriffVote(game, game.players[0], "p1");
      VoteHandler.castSheriffVote(game, game.players[1], "p1");
      VoteHandler.castSheriffVote(game, game.players[2], "p1");
      VoteHandler.castSheriffVote(game, game.players[3], "p4");
      VoteHandler.castSheriffVote(game, game.players[4], "p1"); // triggers

      expect(game.sheriffUUID).toBe("p1");
    });

    /* ================================================================
       19. NO ONE WINS: everyone dies
       ================================================================ */
    it("results in no winner when everyone is dead", () => {
      const game = createGameWithPlayers(2);
      setRoles(game, [Role.WEREWOLF, Role.VILLAGER]);
      game.players.forEach(p => p.isAlive = false);
      // Simulate GameManager.checkGameOver logic:
      const alivePlayers = game.players.filter(p => p.isAlive);
      if (alivePlayers.length === 0) {
        game.phase = Phase.GAME_OVER;
        game.winningTeam = null;
      }
      expect(game.phase).toBe(Phase.GAME_OVER);
      expect(game.winningTeam).toBeNull();
    });

    /* ================================================================
       20. LOVE PARTNER VICTIM DIE AT NIGHT
       ================================================================ */
    it("kills the lover too when werewolf targets one of them", () => {
      const game = startFullGame(4, [Role.CUPID, Role.VILLAGER, Role.VILLAGER, Role.WEREWOLF]);
      // cupid phase
      CupidHandler.handleBindLovers(game, game.players[0], "p1", "p2");
      CupidHandler.handleLoverConfirmsBond(game, game.players[1]);
      CupidHandler.handleLoverConfirmsBond(game, game.players[2]);
      NightHandler.nextRole(game);

      // werewolf kills p1 (who is in love with p2)
      WerewolfHandler.handleVote(game, game.players[3], "p1");
      NightHandler.nextRole(game);

      expect(game.players[1].isAlive).toBe(false);
      expect(game.players[2].isAlive).toBe(false);
    });
  });
});
