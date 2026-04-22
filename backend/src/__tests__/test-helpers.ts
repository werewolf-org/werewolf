import { Role } from "@shared/roles.js";
import { Phase } from "@shared/phases.js";
import type { Game, Player } from "../models.js";

export const createMockGame = (overrides: Partial<Game> = {}): Game => ({
  gameId: "ABCD",
  managerUUID: null,
  players: [],
  round: 0,
  phase: Phase.LOBBY,
  activeNightRole: null,
  winningTeam: null,
  sheriffUUID: null,
  lynchDone: false,
  sheriffElectionDone: false,
  lastVotedOutUUID: null,
  createdAt: Date.now(),
  ...overrides,
});

export const createMockPlayer = (overrides: Partial<Player> = {}): Player => ({
  playerUUID: "player-" + Math.random().toString(36).slice(2, 8),
  socketId: "socket-" + Math.random().toString(36).slice(2, 8),
  displayName: "Test Player",
  role: null,
  isAlive: true,
  nightAction: null,
  lovePartner: null,
  lovePartnerConfirmed: false,
  usedHealingPotion: false,
  usedKillingPotion: false,
  nominationUUID: null,
  voteTargetUUID: null,
  readyForNight: false,
  ...overrides,
});

export const createGameWithPlayers = (
  playerCount: number,
  overrides: Partial<Game> = {}
): Game => {
  const players: Player[] = Array.from({ length: playerCount }, (_, i) =>
    createMockPlayer({
      playerUUID: `p${i}`,
      socketId: `s${i}`,
      displayName: `Player ${i}`,
    })
  );
  return createMockGame({ players, ...overrides });
};

export const setRoles = (game: Game, roles: Role[]): void => {
  game.players.forEach((p, i) => {
    p.role = roles[i] ?? null;
  });
};
