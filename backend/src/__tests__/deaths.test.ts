import { describe, it, expect } from "vitest";
import { Role } from "@shared/roles.js";
import { createGameWithPlayers, setRoles } from "./test-helpers.js";
import { resolveDeaths, resolveNightDeaths, type NightDeathInput } from "../logic/rules/deaths.js";

const night = (overrides: Partial<NightDeathInput> = {}): NightDeathInput => ({
    werewolfVictimUUID: null,
    witchHeal: false,
    witchKillUUID: null,
    redLadySleepoverUUID: null,
    ...overrides,
});

describe("resolveDeaths", () => {
    it("kills the named victims and reports them", () => {
        const game = createGameWithPlayers(3);

        const deaths = resolveDeaths(game, ["p1"]);

        expect(game.players[1]!.isAlive).toBe(false);
        expect(deaths).toEqual(["p1"]);
    });

    it("takes a living lover with the victim", () => {
        const game = createGameWithPlayers(3);
        game.players[1]!.lovePartner = "p2";
        game.players[2]!.lovePartner = "p1";

        const deaths = resolveDeaths(game, ["p1"]);

        expect(game.players[1]!.isAlive).toBe(false);
        expect(game.players[2]!.isAlive).toBe(false);
        expect(deaths).toEqual(["p1", "p2"]);
    });

    it("skips a corpse and does not kill their lover", () => {
        const game = createGameWithPlayers(3);
        game.players[1]!.lovePartner = "p2";
        game.players[2]!.lovePartner = "p1";
        game.players[2]!.isAlive = false;

        const deaths = resolveDeaths(game, ["p2"]);

        expect(game.players[1]!.isAlive).toBe(true);
        expect(deaths).toEqual([]);
    });

    it("kills and reports a player only once", () => {
        const game = createGameWithPlayers(3);
        game.players[1]!.lovePartner = "p2";
        game.players[2]!.lovePartner = "p1";

        const deaths = resolveDeaths(game, ["p1", "p2", "p1"]);

        expect(deaths).toEqual(["p1", "p2"]);
    });

    it("throws on a missing lover and leaves the table untouched", () => {
        const game = createGameWithPlayers(2);
        game.players[0]!.lovePartner = "ghost";

        expect(() => resolveDeaths(game, ["p0"])).toThrow("cannot be a love partner");
        expect(game.players[0]!.isAlive).toBe(true);
    });

    it("clears the badge when the sheriff dies", () => {
        const game = createGameWithPlayers(3);
        game.sheriffUUID = "p1";

        resolveDeaths(game, ["p1"]);

        expect(game.sheriffUUID).toBeNull();
    });

    it("keeps the badge when the sheriff survives", () => {
        const game = createGameWithPlayers(3);
        game.sheriffUUID = "p2";

        resolveDeaths(game, ["p1"]);

        expect(game.sheriffUUID).toBe("p2");
    });

    it("clears a badge left on a corpse even with no victims", () => {
        const game = createGameWithPlayers(3);
        game.sheriffUUID = "p1";
        game.players[1]!.isAlive = false;

        resolveDeaths(game, []);

        expect(game.sheriffUUID).toBeNull();
    });
});

describe("resolveNightDeaths", () => {
    it("kills the werewolf victim", () => {
        const game = createGameWithPlayers(3);
        setRoles(game, [Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER]);

        const deaths = resolveNightDeaths(game, night({ werewolfVictimUUID: "p1" }));

        expect(game.players[1]!.isAlive).toBe(false);
        expect(deaths).toEqual(["p1"]);
    });

    it("heals the werewolf victim", () => {
        const game = createGameWithPlayers(3);
        setRoles(game, [Role.WEREWOLF, Role.WITCH, Role.VILLAGER]);

        const deaths = resolveNightDeaths(game, night({ werewolfVictimUUID: "p2", witchHeal: true }));

        expect(game.players[2]!.isAlive).toBe(true);
        expect(deaths).toEqual([]);
    });

    it("poisons a second player while the pack kills another", () => {
        const game = createGameWithPlayers(4);
        setRoles(game, [Role.WEREWOLF, Role.WITCH, Role.VILLAGER, Role.VILLAGER]);

        const deaths = resolveNightDeaths(game, night({ werewolfVictimUUID: "p2", witchKillUUID: "p3" }));

        expect(game.players[2]!.isAlive).toBe(false);
        expect(game.players[3]!.isAlive).toBe(false);
        expect(deaths).toEqual(["p2", "p3"]);
    });

    it("does not kill a player the witch heals and poisons in the same night", () => {
        const game = createGameWithPlayers(3);
        setRoles(game, [Role.WEREWOLF, Role.WITCH, Role.VILLAGER]);

        const deaths = resolveNightDeaths(game, night({ werewolfVictimUUID: "p2", witchHeal: true, witchKillUUID: "p2" }));

        expect(game.players[2]!.isAlive).toBe(true);
        expect(deaths).toEqual([]);
    });

    it("lets the red lady escape the pack's attack", () => {
        const game = createGameWithPlayers(3);
        setRoles(game, [Role.RED_LADY, Role.WEREWOLF, Role.VILLAGER]);

        const deaths = resolveNightDeaths(game, night({ werewolfVictimUUID: "p0", redLadySleepoverUUID: "p2" }));

        expect(game.players[0]!.isAlive).toBe(true);
        expect(deaths).toEqual([]);
    });

    it("kills the red lady when the host she visited died", () => {
        const game = createGameWithPlayers(3);
        setRoles(game, [Role.RED_LADY, Role.WEREWOLF, Role.VILLAGER]);

        const deaths = resolveNightDeaths(game, night({ werewolfVictimUUID: "p2", redLadySleepoverUUID: "p2" }));

        expect(game.players[0]!.isAlive).toBe(false);
        expect(game.players[2]!.isAlive).toBe(false);
        expect(deaths).toEqual(["p2", "p0"]);
    });

    it("does not let the red lady escape the witch's poison", () => {
        const game = createGameWithPlayers(3);
        setRoles(game, [Role.RED_LADY, Role.WITCH, Role.VILLAGER]);

        const deaths = resolveNightDeaths(game, night({ witchKillUUID: "p0", redLadySleepoverUUID: "p2" }));

        expect(game.players[0]!.isAlive).toBe(false);
        expect(deaths).toEqual(["p0"]);
    });

    it("kills the red lady who sleeps at her lover's place when the lover dies", () => {
        const game = createGameWithPlayers(3);
        setRoles(game, [Role.RED_LADY, Role.WEREWOLF, Role.VILLAGER]);
        game.players[0]!.lovePartner = "p2";
        game.players[2]!.lovePartner = "p0";

        // The host is also her lover: the host rule and the lover cascade agree.
        const deaths = resolveNightDeaths(game, night({ werewolfVictimUUID: "p2", redLadySleepoverUUID: "p2" }));

        expect(game.players[0]!.isAlive).toBe(false);
        expect(game.players[2]!.isAlive).toBe(false);
        expect(deaths).toEqual(["p2", "p0"]);
    });

    it("clears the badge when the sheriff is a night victim", () => {
        const game = createGameWithPlayers(3);
        setRoles(game, [Role.WEREWOLF, Role.VILLAGER, Role.VILLAGER]);
        game.sheriffUUID = "p1";

        resolveNightDeaths(game, night({ werewolfVictimUUID: "p1" }));

        expect(game.sheriffUUID).toBeNull();
    });
});
