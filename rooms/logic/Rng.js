// rooms/logic/Rng.js
// Verbatim port of client Rng.js — deterministic PRNG (mulberry32).
// Server is now the sole source of "random" (wind), so this seed only
// ever needs to be generated once here and never sent anywhere except
// as a broadcast for clients to replay any *cosmetic* randomness they
// might still want locally (none currently, but kept for parity).

function createRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { createRng };
