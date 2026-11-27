import { describe, it, expect, beforeEach } from "vitest";
import { GameJournal, describeChanges, renderDumpText, journal } from "../debug/journal.js";
import { createGameWithPlayers, setRoles } from "./test-helpers.js";
import { Role } from "@shared/roles.js";
import { Phase } from "@shared/phases.js";

describe("GameJournal", () => {
  it("assigns increasing sequence numbers and keeps order", () => {
    const journal = new GameJournal("AB12");
    journal.note("game.created");
    journal.note("second");
    journal.note("third");

    const dump = journal.dump();
    expect(dump.journal.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(dump.journal.map((e) => e.name)).toEqual(["game.created", "second", "third"]);
    expect(dump.events).toBe(3);
    expect(dump.dropped).toBe(0);
  });

  it("skips a state that did not change but records every real change", () => {
    const game = createGameWithPlayers(2);
    const journal = new GameJournal("AB12");

    expect(journal.recordState(game)).not.toBeNull();
    expect(journal.recordState(game), "an identical broadcast is noise").toBeNull();

    game.phase = Phase.NIGHT;
    expect(journal.recordState(game)).not.toBeNull();
    expect(journal.stored).toBe(2);
  });

  it("annotates a rejected action with the server error", () => {
    const journal = new GameJournal("AB12");
    const action = journal.beginAction("vote", "s0", "p0", { gameId: "AB12", voteTargetUUID: "p1" });
    action.finish(false, 4, "It is not your turn.");

    const dump = journal.dump();
    const entry = dump.journal.find((e) => e.seq === action.seq)!;
    expect(entry.ok).toBe(false);
    expect(entry.error).toBe("It is not your turn.");
    expect(entry.ms).toBe(4);
    expect(renderDumpText(dump)).toContain("REJECTED: It is not your turn.");
  });

  it("marks an action whose handler is still running", () => {
    const journal = new GameJournal("AB12");
    journal.beginAction("vote", "s0", "p0", { gameId: "AB12" });
    expect(renderDumpText(journal.dump())).toContain("[still running]");
  });

  it("drops the oldest entries when the event budget is full", () => {
    const journal = new GameJournal("AB12", { maxEvents: 3 });
    for (let i = 0; i < 6; i++) journal.note(`n${i}`);

    const dump = journal.dump();
    expect(dump.events).toBe(3);
    expect(dump.dropped).toBe(3);
    expect(dump.journal.map((e) => e.name)).toEqual(["n3", "n4", "n5"]);
    expect(dump.journal[0]!.seq).toBe(3);
    expect(renderDumpText(dump)).toContain("3 older events dropped");
  });

  it("drops the oldest entries when the byte budget is full", () => {
    const journal = new GameJournal("AB12", { maxBytes: 2400 });
    for (let i = 0; i < 20; i++) journal.note(`event-${i}`, null, { pad: "x".repeat(120) });

    const dump = journal.dump();
    expect(dump.journal.length).toBeGreaterThan(0);
    expect(dump.journal.length).toBeLessThan(20);
    expect(dump.dropped).toBe(20 - dump.journal.length);
  });

  it("renders names, roles, deaths and ballots instead of uuids", () => {
    const game = createGameWithPlayers(3);
    setRoles(game, [Role.WEREWOLF, Role.VILLAGER, Role.SEER]);
    game.managerUUID = "p0";

    const journal = new GameJournal("AB12");
    journal.recordState(game);

    const action = journal.beginAction("vote", "s0", "p0", { gameId: "AB12", voteTargetUUID: "p1" });
    action.finish(true, 2);
    game.players[0]!.voteTargetUUID = "p1";
    journal.recordState(game);

    game.players[1]!.isAlive = false;
    journal.recordState(game);

    const text = renderDumpText(journal.dump());
    expect(text).toContain("WEREWOLF");
    expect(text).toContain("Player 0 voted Player 1");
    expect(text).toContain("Player 1 died (VILLAGER)");
    expect(text).toContain("vote");
    // No raw uuid of a known player leaks into the transcript.
    expect(text).not.toContain("p0 ");
  });

  it("filters events for an incremental dump", () => {
    const journal = new GameJournal("AB12");
    journal.note("a");
    journal.note("b");
    journal.note("c");

    const all = journal.dump();
    const since = all.journal[0]!.seq;
    expect(journal.eventsSince(since).map((e) => e.name)).toEqual(["b", "c"]);
    expect(journal.eventsSince(null)).toHaveLength(3);
  });

  it("reports staleness from the last event, not from creation", () => {
    const journal = new GameJournal("AB12");
    journal.note("a");
    const last = journal.lastEventAt;
    expect(journal.isStale(last + 1000, 5000)).toBe(false);
    expect(journal.isStale(last + 6000, 5000)).toBe(true);
  });
});

describe("journal registry", () => {
  beforeEach(() => {
    journal.reset();
  });

  it("lists live games and truncates an oversized shutdown dump", () => {
    const game = createGameWithPlayers(2);
    game.gameId = "ZZZZ";
    journal.noteGameCreated(game);
    const live = journal.getOrCreate("ZZZZ");
    for (let i = 0; i < 40; i++) live.note(`note-${i}`, null, { pad: "x".repeat(200) });

    const listed = journal.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.gameId).toBe("ZZZZ");
    expect(listed[0]!.events).toBe(41);
    expect(listed[0]!.players).toBe(2);

    const dumps = journal.dumpAll(500);
    expect(dumps).toHaveLength(1);
    expect(dumps[0]!.text).toContain("[truncated:");
  });

  it("answers a dump only for a known game", () => {
    expect(journal.dump("NOPE")).toBeNull();
    const game = createGameWithPlayers(2);
    journal.noteGameCreated(game);
    expect(journal.dump(game.gameId)?.gameId).toBe(game.gameId);
  });
});

describe("describeChanges", () => {
  it("describes a phase and round transition", () => {
    const before = createGameWithPlayers(3);
    const after = createGameWithPlayers(3);
    after.phase = Phase.NIGHT;
    after.round = 1;
    after.activeNightRole = Role.SEER;

    expect(describeChanges(before, after)).toEqual([
      "phase LOBBY -> NIGHT",
      "round 0 -> 1",
      "active none -> SEER",
    ]);
  });

  it("describes a nomination, a ballot and an abstain", () => {
    const before = createGameWithPlayers(3);
    const after = createGameWithPlayers(3);
    after.players[0]!.nominationUUID = "p1";
    after.players[1]!.voteTargetUUID = false;

    expect(describeChanges(before, after)).toEqual([
      "Player 0 nominated Player 1",
      "Player 1 voted abstain",
    ]);
  });

  it("describes a night action in game terms", () => {
    const before = createGameWithPlayers(3);
    const after = createGameWithPlayers(3);
    after.players[0]!.nightAction = { targetUUID: "p1" };

    expect(describeChanges(before, after)).toEqual(["Player 0 night target Player 1"]);
  });
});
