import { describe, it, expect } from "vitest";
import { createMockGame, createMockPlayer, createGameWithPlayers, setRoles } from "./test-helpers.js";
import { Phase } from "@shared/phases.js";
import { Role } from "@shared/roles.js";
import { getLocalPlayerState } from "../logic/communication/sync.provider.js";

describe("sync.provider", () => {
  it("throws if player has no socketId", () => {
    const game = createGameWithPlayers(1);
    game.players[0]!.socketId = null;
    expect(() => getLocalPlayerState(game, game.players[0]!)).toThrow("does not have a socketID");
  });

  it("hides roles from alive players when not GAME_OVER", () => {
    const game = createGameWithPlayers(2);
    setRoles(game, [Role.WEREWOLF, Role.VILLAGER]);
    game.phase = Phase.DAY;
    const state = getLocalPlayerState(game, game.players[0]!);
    expect(state.players[0]!.role).toBeNull();
    expect(state.players[1]!.role).toBeNull();
  });

  it("reveals roles to dead players even when not GAME_OVER", () => {
    const game = createGameWithPlayers(2);
    setRoles(game, [Role.WEREWOLF, Role.VILLAGER]);
    game.phase = Phase.DAY;
    game.players[0]!.isAlive = false;
    const state = getLocalPlayerState(game, game.players[0]!);
    expect(state.players[0]!.role).toBe(Role.WEREWOLF); // dead player's own role revealed
    expect(state.players[1]!.role).toBeNull(); // alive player's role hidden
  });

  it("reveals all roles during GAME_OVER", () => {
    const game = createGameWithPlayers(2);
    setRoles(game, [Role.WEREWOLF, Role.VILLAGER]);
    game.phase = Phase.GAME_OVER;
    const state = getLocalPlayerState(game, game.players[0]!);
    expect(state.players[0]!.role).toBe(Role.WEREWOLF);
    expect(state.players[1]!.role).toBe(Role.VILLAGER);
  });

  it("shows werewolfVotes to alive werewolves", () => {
    const game = createGameWithPlayers(3);
    setRoles(game, [Role.WEREWOLF, Role.WEREWOLF, Role.VILLAGER]);
    game.players[0]!.nightAction = { targetUUID: "p2" };
    game.players[1]!.nightAction = { targetUUID: "p2" };
    const state = getLocalPlayerState(game, game.players[0]!);
    expect(state.werewolfVotes).toEqual({ p0: "p2", p1: "p2" });
  });

  it("hides werewolfVotes from non-werewolves", () => {
    const game = createGameWithPlayers(3);
    setRoles(game, [Role.WEREWOLF, Role.WEREWOLF, Role.VILLAGER]);
    game.players[0]!.nightAction = { targetUUID: "p2" };
    const state = getLocalPlayerState(game, game.players[2]!);
    expect(state.werewolfVotes).toBeNull();
  });

  it("hides werewolfVotes from dead werewolves", () => {
    const game = createGameWithPlayers(2);
    setRoles(game, [Role.WEREWOLF, Role.VILLAGER]);
    game.players[0]!.isAlive = false;
    game.players[0]!.nightAction = { targetUUID: "p1" };
    const state = getLocalPlayerState(game, game.players[0]!);
    expect(state.werewolfVotes).toBeNull();
  });

  it("shows werewolfVictim to alive werewolf", () => {
    const game = createGameWithPlayers(2);
    setRoles(game, [Role.WEREWOLF, Role.VILLAGER]);
    game.players[0]!.nightAction = { targetUUID: "p1" };
    const state = getLocalPlayerState(game, game.players[0]!);
    expect(state.werewolfVictim).toBe("p1");
  });

  it("shows werewolfVictim to alive witch", () => {
    const game = createGameWithPlayers(3);
    setRoles(game, [Role.WEREWOLF, Role.WITCH, Role.VILLAGER]);
    game.players[0]!.nightAction = { targetUUID: "p2" };
    const state = getLocalPlayerState(game, game.players[1]!);
    expect(state.werewolfVictim).toBe("p2");
  });

  it("hides werewolfVictim from villager", () => {
    const game = createGameWithPlayers(2);
    setRoles(game, [Role.WEREWOLF, Role.VILLAGER]);
    game.players[0]!.nightAction = { targetUUID: "p1" };
    const state = getLocalPlayerState(game, game.players[1]!);
    expect(state.werewolfVictim).toBeNull();
  });

  it("shows seerRevealUUID/seerRevealRole to seer", () => {
    const game = createGameWithPlayers(2);
    setRoles(game, [Role.SEER, Role.WEREWOLF]);
    game.players[0]!.nightAction = { revealUUID: "p1", revealedRole: Role.WEREWOLF };
    const state = getLocalPlayerState(game, game.players[0]!);
    expect(state.seerRevealUUID).toBe("p1");
    expect(state.seerRevealRole).toBe(Role.WEREWOLF);
  });

  it("does not show seerReveal to non-seer", () => {
    const game = createGameWithPlayers(2);
    setRoles(game, [Role.SEER, Role.WEREWOLF]);
    game.players[0]!.nightAction = { revealUUID: "p1", revealedRole: Role.WEREWOLF };
    const state = getLocalPlayerState(game, game.players[1]!);
    expect(state.seerRevealUUID).toBeNull();
    expect(state.seerRevealRole).toBeNull();
  });

  it("shows redLadySleepoverUUID to red lady", () => {
    const game = createGameWithPlayers(2);
    setRoles(game, [Role.RED_LADY, Role.VILLAGER]);
    game.players[0]!.nightAction = { sleepoverUUID: "p1" };
    const state = getLocalPlayerState(game, game.players[0]!);
    expect(state.redLadySleepoverUUID).toBe("p1");
  });

  it("does not show redLadySleepoverUUID to non-red lady", () => {
    const game = createGameWithPlayers(2);
    setRoles(game, [Role.RED_LADY, Role.VILLAGER]);
    game.players[0]!.nightAction = { sleepoverUUID: "p1" };
    const state = getLocalPlayerState(game, game.players[1]!);
    expect(state.redLadySleepoverUUID).toBeNull();
  });

  it("shows cupid lover info to cupid and lovers", () => {
    const game = createGameWithPlayers(3);
    setRoles(game, [Role.CUPID, Role.VILLAGER, Role.VILLAGER]);
    game.players[0]!.nightAction = { firstPlayerUUID: "p1", secondPlayerUUID: "p2" };
    game.players[1]!.lovePartner = "p2";
    game.players[2]!.lovePartner = "p1";
    game.players[1]!.lovePartnerConfirmed = true;
    game.players[2]!.lovePartnerConfirmed = false;

    const cupidState = getLocalPlayerState(game, game.players[0]!);
    expect(cupidState.cupidSelectedLovers).toBe(true);
    expect(cupidState.cupidFirstLoverUUID).toBe("p1");
    expect(cupidState.cupidSecondLoverUUID).toBe("p2");
    expect(cupidState.cupidFirstLoverConfirmed).toBe(true);
    expect(cupidState.cupidSecondLoverConfirmed).toBe(false);

    const lover1State = getLocalPlayerState(game, game.players[1]!);
    expect(lover1State.cupidSelectedLovers).toBe(true);
    expect(lover1State.cupidFirstLoverUUID).toBe("p1");

    const lover2State = getLocalPlayerState(game, game.players[2]!);
    expect(lover2State.cupidSelectedLovers).toBe(true);
    expect(lover2State.cupidSecondLoverUUID).toBe("p2");
  });

  it("hides cupid lover info from non-involved players", () => {
    const game = createGameWithPlayers(4);
    setRoles(game, [Role.CUPID, Role.VILLAGER, Role.VILLAGER, Role.VILLAGER]);
    game.players[0]!.nightAction = { firstPlayerUUID: "p1", secondPlayerUUID: "p2" };
    game.players[1]!.lovePartner = "p2";
    game.players[2]!.lovePartner = "p1";
    const state = getLocalPlayerState(game, game.players[3]!);
    // An uninvolved player may not even learn that a Cupid exists
    expect(state.cupidSelectedLovers).toBe(false);
    expect(state.cupidFirstLoverUUID).toBeNull();
    expect(state.cupidSecondLoverUUID).toBeNull();
    expect(state.cupidFirstLoverConfirmed).toBe(false);
    expect(state.cupidSecondLoverConfirmed).toBe(false);
  });

  it("tells the game manager that the cupid picked, for the narration", () => {
    const game = createGameWithPlayers(4, { managerUUID: "p3" });
    setRoles(game, [Role.CUPID, Role.VILLAGER, Role.VILLAGER, Role.VILLAGER]);
    game.players[0]!.nightAction = { firstPlayerUUID: "p1", secondPlayerUUID: "p2" };
    game.players[1]!.lovePartner = "p2";
    game.players[2]!.lovePartner = "p1";
    // p3 is the manager and is not involved in the bond: they still need the flag to play the narration
    const state = getLocalPlayerState(game, game.players[3]!);
    expect(state.cupidSelectedLovers).toBe(true);
    expect(state.cupidFirstLoverUUID).toBeNull();
  });

  it("shows witch potion usage to witch", () => {
    const game = createGameWithPlayers(1);
    setRoles(game, [Role.WITCH]);
    game.players[0]!.usedHealingPotion = true;
    game.players[0]!.usedKillingPotion = false;
    const state = getLocalPlayerState(game, game.players[0]!);
    expect(state.witchUsedHealingPotion).toBe(true);
    expect(state.witchUsedKillingPotion).toBe(false);
  });

  it("exposes correct isManager and lovePartnerUUID", () => {
    const game = createGameWithPlayers(2);
    game.managerUUID = "p0";
    game.players[0]!.lovePartner = "p1";
    const state = getLocalPlayerState(game, game.players[0]!);
    expect(state.isManager).toBe(true);
    expect(state.lovePartnerUUID).toBe("p1");
    expect(state.displayName).toBe("Player 0");
  });

  it("includes voteProgress in state", () => {
    const game = createGameWithPlayers(3);
    game.players[0]!.voteTargetUUID = "p1";
    game.players[1]!.voteTargetUUID = false;
    const state = getLocalPlayerState(game, game.players[0]!);
    expect(state.voteProgress).toEqual({ voted: 2, total: 3 });
  });

  it("publishes who has decided but never what they chose", () => {
    const game = createGameWithPlayers(3);
    game.players[0]!.voteTargetUUID = "p1";
    game.players[1]!.voteTargetUUID = false;
    const state = getLocalPlayerState(game, game.players[0]!);

    // Participation is public: an abstain counts as decided, just like a named ballot.
    expect(state.players.map((p: any) => p.hasVoted)).toEqual([true, true, false]);

    // The choice is not. Only the viewer's own target survives, and only in its own field.
    expect(state.myVoteTargetUUID).toBe("p1");
    for (const entry of state.players) {
      expect(entry).not.toHaveProperty("voteTargetUUID");
      expect(entry).not.toHaveProperty("vote");
    }
  });

  it("publishes who has confirmed the night, and nothing private about it", () => {
    const game = createGameWithPlayers(3);
    game.phase = Phase.DAY;
    game.lynchDone = true;
    game.players[0]!.readyForNight = true;

    // Every seat sees the same participation flags, including the viewer's own.
    const state = getLocalPlayerState(game, game.players[1]!);
    expect(state.players.map((p: any) => p.readyForNight)).toEqual([true, false, false]);
    expect(state.readyForNight).toBe(false);
    expect(state.players[0]!).not.toHaveProperty("socketId");
    expect(state.players[0]!).not.toHaveProperty("nightAction");
  });

  it("hides voteResults until voting is complete", () => {
    const game = createGameWithPlayers(2);
    game.players[0]!.voteTargetUUID = "p1";
    const state = getLocalPlayerState(game, game.players[0]!);
    expect(state.voteResults).toBeNull();
  });

  it("includes nominationsFinished", () => {
    const game = createGameWithPlayers(2);
    game.players[0]!.nominationUUID = "p1";
    const state = getLocalPlayerState(game, game.players[0]!);
    expect(state.nominationsFinished).toBe(false);
    game.players[1]!.nominationUUID = false;
    const state2 = getLocalPlayerState(game, game.players[0]!);
    expect(state2.nominationsFinished).toBe(true);
  });

  it("localPlayerList includes correct public fields", () => {
    const game = createGameWithPlayers(2);
    game.sheriffUUID = "p0";
    setRoles(game, [Role.VILLAGER, Role.WEREWOLF]);
    game.phase = Phase.DAY;
    const state = getLocalPlayerState(game, game.players[0]!);
    expect(state.players).toHaveLength(2);
    expect(state.players[0]!).toMatchObject({
      playerUUID: "p0",
      displayName: "Player 0",
      isSheriff: true,
      isAlive: true,
      nomination: null,
      role: null, // hidden in DAY
    });
  });
});
