// The binding between a socket and the seat it holds.
//
// A seat is one player inside one game. It can be held by more than one socket at a
// time: a second tab, a reopened link, or a reconnect that arrives before the server
// has noticed the old socket died. All of them are real phones showing real state, so
// all of them get snapshots and any of them may act.
//
// The registry owns the two facts that are easy to get wrong:
//   - a socket holds at most one seat (moving it must drop the previous binding);
//   - the last bound socket is the seat's primary, so when it leaves the previous one
//     is promoted instead of the seat going dark.

export interface Seat {
    readonly gameId: string;
    readonly playerUUID: string;
}

export interface SeatRelease {
    /** The seat the socket held before this operation. */
    seat: Seat;
    /** Sockets still bound to that seat, in bind order. */
    remaining: string[];
    /** The socket that should become the player's primary, or null when none remain. */
    nextPrimary: string | null;
}

export class SeatRegistry {
    private readonly seatBySocket = new Map<string, Seat>();
    private readonly socketsBySeat = new Map<string, Set<string>>();

    private key(seat: Seat): string {
        return `${seat.gameId}:${seat.playerUUID}`;
    }

    private sameSeat(a: Seat, b: Seat): boolean {
        return a.gameId === b.gameId && a.playerUUID === b.playerUUID;
    }

    /**
     * Bind a socket to a seat.
     *
     * A socket holds one seat at a time. Binding it to a different seat releases the
     * old one first; the returned release lets the caller repair the old player's
     * primary socket. Binding the same socket to the same seat is idempotent.
     */
    bind(seat: Seat, socketId: string): SeatRelease | undefined {
        const previous = this.seatBySocket.get(socketId);
        const released = previous && !this.sameSeat(previous, seat)
            ? this.release(socketId)
            : undefined;

        const key = this.key(seat);
        let sockets = this.socketsBySeat.get(key);
        if(!sockets) {
            sockets = new Set();
            this.socketsBySeat.set(key, sockets);
        }
        sockets.add(socketId);
        this.seatBySocket.set(socketId, { gameId: seat.gameId, playerUUID: seat.playerUUID });
        return released;
    }

    /**
     * Release a socket from whatever seat it holds. Returns undefined for a socket that
     * never held a seat. The caller decides whether the released socket was the primary
     * one before applying `nextPrimary`.
     */
    release(socketId: string): SeatRelease | undefined {
        const seat = this.seatBySocket.get(socketId);
        if(!seat) return undefined;

        this.seatBySocket.delete(socketId);
        return this.removeFromSeat(seat, socketId);
    }

    /** The sockets holding this seat, in bind order. A copy: mutating it changes nothing. */
    socketsFor(seat: Seat): string[] {
        return [...(this.socketsBySeat.get(this.key(seat)) ?? [])];
    }

    /** The seat this socket holds, or undefined when it holds none. */
    seatOf(socketId: string): Seat | undefined {
        return this.seatBySocket.get(socketId);
    }

    private removeFromSeat(seat: Seat, socketId: string): SeatRelease {
        const key = this.key(seat);
        const sockets = this.socketsBySeat.get(key);
        sockets?.delete(socketId);

        const remaining = sockets ? [...sockets] : [];
        if(sockets && sockets.size === 0) this.socketsBySeat.delete(key);

        return {
            seat,
            remaining,
            nextPrimary: remaining[remaining.length - 1] ?? null,
        };
    }
}
