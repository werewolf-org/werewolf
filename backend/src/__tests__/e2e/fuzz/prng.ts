// Tiny deterministic PRNG for the e2e fuzz driver (mulberry32, no dependencies).
//
// Reproducibility contract:
// - every random choice the *driver* makes goes through an `Rng` instance seeded from
//   `E2E_SEED` (or a printed per-run seed when the env var is absent);
// - the server shuffles roles with `Math.random`, so the driver additionally reseeds
//   `Math.random` for the single `roleDistribution` call (see `fuzz.test.ts`) with a
//   seed derived from the same base seed. That makes the whole run -- role deal
//   included -- replayable from the printed seed.

export interface Rng {
    /** Uniform float in [0, 1). */
    next(): number;
    /** Uniform integer in [min, max], both inclusive. */
    int(min: number, max: number): number;
    /** Uniform element of a non-empty array. */
    pick<T>(items: readonly T[]): T;
    /** Fisher-Yates copy, the input is left untouched. */
    shuffle<T>(items: readonly T[]): T[];
    /** True with probability `p` (default 0.5). */
    bool(p?: number): boolean;
}

export function makeRng(seed: number): Rng {
    let state = seed >>> 0;

    const next = (): number => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const int = (min: number, max: number): number => {
        const lo = Math.ceil(Math.min(min, max));
        const hi = Math.floor(Math.max(min, max));
        return lo + Math.floor(next() * (hi - lo + 1));
    };

    const pick = <T>(items: readonly T[]): T => {
        if (items.length === 0) throw new Error('makeRng.pick: cannot pick from an empty array');
        return items[int(0, items.length - 1)] as T;
    };

    const shuffle = <T>(items: readonly T[]): T[] => {
        const copy = items.slice();
        for (let i = copy.length - 1; i > 0; i--) {
            const j = int(0, i);
            const tmp = copy[i] as T;
            copy[i] = copy[j] as T;
            copy[j] = tmp;
        }
        return copy;
    };

    const bool = (p = 0.5): boolean => next() < p;

    return { next, int, pick, shuffle, bool };
}

export interface SeedInfo {
    seed: number;
    source: 'env' | 'random';
}

/** `E2E_SEED` wins; otherwise a random seed that the test prints so CI failures are replayable. */
export function resolveSeed(env: NodeJS.ProcessEnv = process.env): SeedInfo {
    const raw = env.E2E_SEED;
    if (raw !== undefined && raw.trim() !== '') {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
            throw new Error(`E2E_SEED must be an integer, got ${JSON.stringify(raw)}`);
        }
        return { seed: parsed >>> 0, source: 'env' };
    }
    return { seed: Math.floor(Math.random() * 0x1_0000_0000), source: 'random' };
}

/** Independent seed for game `index` / sub-stream `stream`, derived from the base seed. */
export function deriveSeed(base: number, index: number, stream = 0): number {
    let h = (base >>> 0) ^ Math.imul(index + 1, 0x85ebca6b) ^ Math.imul(stream + 1, 0xc2b2ae35);
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    return (h ^ (h >>> 16)) >>> 0;
}
