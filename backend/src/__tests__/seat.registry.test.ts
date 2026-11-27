import { describe, it, expect } from "vitest";
import { SeatRegistry, type Seat } from "../logic/seat.registry.js";

const seatA: Seat = { gameId: "AAAA", playerUUID: "p1" };
const seatB: Seat = { gameId: "BBBB", playerUUID: "p2" };

describe("SeatRegistry", () => {
    it("binds a socket to a seat and reads it back", () => {
        const registry = new SeatRegistry();
        registry.bind(seatA, "s1");

        expect(registry.seatOf("s1")).toEqual(seatA);
        expect(registry.socketsFor(seatA)).toEqual(["s1"]);
    });

    it("keeps every socket on one seat in bind order", () => {
        const registry = new SeatRegistry();
        registry.bind(seatA, "s1");
        registry.bind(seatA, "s2");

        expect(registry.socketsFor(seatA)).toEqual(["s1", "s2"]);
        expect(registry.seatOf("s2")).toEqual(seatA);
    });

    it("reports the survivor as the next primary when one of two leaves", () => {
        const registry = new SeatRegistry();
        registry.bind(seatA, "s1");
        registry.bind(seatA, "s2");

        const released = registry.release("s1");

        expect(released).toEqual({ seat: seatA, remaining: ["s2"], nextPrimary: "s2" });
        expect(registry.seatOf("s1")).toBeUndefined();
        expect(registry.socketsFor(seatA)).toEqual(["s2"]);
    });

    it("promotes the most recently bound survivor", () => {
        const registry = new SeatRegistry();
        registry.bind(seatA, "s1");
        registry.bind(seatA, "s2");
        registry.bind(seatA, "s3");

        const released = registry.release("s3");

        expect(released?.nextPrimary).toBe("s2");
        expect(released?.remaining).toEqual(["s1", "s2"]);
    });

    it("reports an empty seat and no primary when the last socket leaves", () => {
        const registry = new SeatRegistry();
        registry.bind(seatA, "s1");

        const released = registry.release("s1");

        expect(released).toEqual({ seat: seatA, remaining: [], nextPrimary: null });
        expect(registry.socketsFor(seatA)).toEqual([]);
    });

    it("returns undefined for a socket that never held a seat", () => {
        const registry = new SeatRegistry();

        expect(registry.release("unknown")).toBeUndefined();
        expect(registry.seatOf("unknown")).toBeUndefined();
        expect(registry.socketsFor(seatA)).toEqual([]);
    });

    it("does not duplicate a socket bound twice to the same seat", () => {
        const registry = new SeatRegistry();
        registry.bind(seatA, "s1");

        expect(registry.bind(seatA, "s1")).toBeUndefined();
        expect(registry.socketsFor(seatA)).toEqual(["s1"]);
    });

    it("moves a socket between seats and returns the old release", () => {
        const registry = new SeatRegistry();
        registry.bind(seatA, "s1");

        const released = registry.bind(seatB, "s1");

        expect(released).toEqual({ seat: seatA, remaining: [], nextPrimary: null });
        expect(registry.seatOf("s1")).toEqual(seatB);
        expect(registry.socketsFor(seatA)).toEqual([]);
        expect(registry.socketsFor(seatB)).toEqual(["s1"]);
    });

    it("returns a copy from socketsFor", () => {
        const registry = new SeatRegistry();
        registry.bind(seatA, "s1");

        const sockets = registry.socketsFor(seatA);
        sockets.push("s2");

        expect(registry.socketsFor(seatA)).toEqual(["s1"]);
    });
});
