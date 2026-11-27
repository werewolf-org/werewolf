import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startGameServer, type GameServerHandle } from "../server.js";
import { GameStore } from "../store/game.store.js";
import { journal } from "../debug/journal.js";
import { createGameWithPlayers, setRoles } from "./test-helpers.js";
import { Role } from "@shared/roles.js";
import type { Game } from "../models.js";

const TOKEN = "test-debug-token";

function seedGame(): Game {
  const game = createGameWithPlayers(3);
  game.gameId = "AB12";
  setRoles(game, [Role.WEREWOLF, Role.VILLAGER, Role.SEER]);
  journal.noteGameCreated(game);
  journal.recordState(game);

  const action = journal.beginAction("AB12", "vote", "s0", "p0", { gameId: "AB12", voteTargetUUID: "p1" });
  action.finish(false, 3, "It is not your turn.");
  return game;
}

async function get(url: string, token: string | null = TOKEN): Promise<Response> {
  return fetch(url, token === null ? {} : { headers: { "x-debug-token": token } });
}

describe("debug http", () => {
  let server: GameServerHandle | null = null;

  beforeEach(async () => {
    GameStore.getInstance().clear();
    journal.reset();
    delete process.env.DEBUG_TOKEN;
    server = await startGameServer(0);
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    delete process.env.DEBUG_TOKEN;
  });

  it("is indistinguishable from a 404 when DEBUG_TOKEN is unset", async () => {
    seedGame();
    expect((await get(`${server!.url}/debug`)).status).toBe(404);
    expect((await get(`${server!.url}/debug/games?token=anything`)).status).toBe(404);
    expect((await get(`${server!.url}/debug/game/AB12`)).status).toBe(404);
  });

  it("requires the token once enabled", async () => {
    process.env.DEBUG_TOKEN = TOKEN;
    seedGame();
    expect((await get(`${server!.url}/debug`, null)).status).toBe(401);
    expect((await get(`${server!.url}/debug`, "wrong")).status).toBe(401);
    expect((await get(`${server!.url}/debug`, TOKEN)).status).toBe(200);
  });

  it("accepts the token in the query string", async () => {
    process.env.DEBUG_TOKEN = TOKEN;
    seedGame();
    const response = await fetch(`${server!.url}/debug/games?token=${TOKEN}`);
    expect(response.status).toBe(200);
    const body = await response.json() as { games: { gameId: string }[] };
    expect(body.games.map((g) => g.gameId)).toContain("AB12");
  });

  it("lands on a list of games with copyable links", async () => {
    process.env.DEBUG_TOKEN = TOKEN;
    seedGame();
    const response = await fetch(`${server!.url}/debug?token=${TOKEN}`);
    const html = await response.text();
    expect(html).toContain("Werwolf debug");
    expect(html).toContain("AB12");
    expect(html).toContain("format=text");
    expect(html).toContain("format=json");
  });

  it("renders a text transcript with the rejected action and the state changes", async () => {
    process.env.DEBUG_TOKEN = TOKEN;
    seedGame();
    const response = await fetch(`${server!.url}/debug/game/AB12?token=${TOKEN}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const text = await response.text();
    expect(text).toContain("=== WEREWOLF DEBUG DUMP ===");
    expect(text).toContain("game      AB12");
    expect(text).toContain("WEREWOLF");
    expect(text).toContain("vote");
    expect(text).toContain("REJECTED: It is not your turn.");
    expect(text).toContain("game.created");
  });

  it("returns the full journal as json", async () => {
    process.env.DEBUG_TOKEN = TOKEN;
    seedGame();
    const response = await get(`${server!.url}/debug/game/ab12?format=json`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      gameId: string;
      state: Game;
      journal: { kind: string; ok: boolean | null; error: string | null }[];
      run: string;
      process: { pid: number };
    };
    expect(body.gameId).toBe("AB12");
    expect(body.state.players).toHaveLength(3);
    expect(body.run).toMatch(/^[0-9a-f]{8}$/);
    expect(body.process.pid).toBe(process.pid);

    const rejected = body.journal.find((entry) => entry.kind === "action");
    expect(rejected?.ok).toBe(false);
    expect(rejected?.error).toBe("It is not your turn.");
  });

  it("supports incremental dumps with since", async () => {
    process.env.DEBUG_TOKEN = TOKEN;
    seedGame();
    const all = await (await get(`${server!.url}/debug/game/AB12?format=json`)).json() as {
      journal: { seq: number }[];
    };
    const since = all.journal[0]!.seq;
    const later = await (await get(`${server!.url}/debug/game/AB12?format=json&since=${since}`)).json() as {
      journal: { seq: number }[];
    };
    expect(later.journal.length).toBe(all.journal.length - 1);
    expect(later.journal.every((entry) => entry.seq > since)).toBe(true);
  });

  it("explains that a missing game is a consequence of the in-memory journal", async () => {
    process.env.DEBUG_TOKEN = TOKEN;
    const response = await get(`${server!.url}/debug/game/ZZZZ`);
    expect(response.status).toBe(404);
    const body = await response.json() as { hint: string };
    expect(body.hint).toContain("stdout");
  });

  it("rejects invalid input instead of guessing", async () => {
    process.env.DEBUG_TOKEN = TOKEN;
    seedGame();
    expect((await get(`${server!.url}/debug/game/AB12?since=nope`)).status).toBe(400);
    expect((await get(`${server!.url}/debug/game/AB12?format=xml`)).status).toBe(400);
    expect((await get(`${server!.url}/debug/game/NOT_A_GAME`)).status).toBe(400);
  });

  it("only serves GET", async () => {
    process.env.DEBUG_TOKEN = TOKEN;
    const response = await fetch(`${server!.url}/debug/games?token=${TOKEN}`, { method: "POST" });
    expect(response.status).toBe(405);
  });

  it("marks a text dump as a download when asked", async () => {
    process.env.DEBUG_TOKEN = TOKEN;
    seedGame();
    const response = await fetch(`${server!.url}/debug/game/AB12?token=${TOKEN}&download=1`);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="werwolf-AB12.txt"');
  });
});
