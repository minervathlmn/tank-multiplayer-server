// rooms/logic/Rng.js
//
// Seeded PRNG, no local requires — sits at the bottom of the dependency graph.

/**
 * Create a seeded pseudo-random number generator (mulberry32).
 *
 * Deterministic and fast: given the same seed, the returned function
 * produces the same sequence of numbers every time. Used wherever
 * gameplay randomness needs to be reproducible (e.g. replaying a match
 * from a stored seed, or keeping all clients' terrain/RNG in sync).
 *
 * Note: `seed` is coerced with `>>> 0`, so a missing/non-numeric seed
 * silently becomes `0` (a valid, deterministic seed) rather than throwing.
 * Callers should always pass an explicit numeric seed.
 *
 * @param {number} seed - 32-bit integer seed. Coerced to unsigned 32-bit.
 * @returns {() => number} A generator function returning floats in [0, 1).
 */
function createRng(seed) {
  let s = seed >>> 0;

  return function () {
    // mulberry32 PRNG. The magic constants below (0x6D2B79F5, 15, 1, 7,
    // 61, 14) are load-bearing to the algorithm's distribution/period —
    // unlike e.g. DRAG_COEFF in constants.js, they are NOT tunable and
    // should not be adjusted for "feel".
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Node sees `module`, browser <script> tag doesn't
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createRng };
}