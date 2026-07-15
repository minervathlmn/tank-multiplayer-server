// rooms/logic/utils.js
// Server-side utils.js.
// - clamp() -> needed by Tank/Projectile terrain-array bounds checks
// - findNextAlive() -> needed directly by GameLogic.playerOrder(), now
//   that GameLogic is the sole turn-order authority server-side
//   (previously assumed superseded by TurnManager.advance() — that
//   reasoning no longer applies since TurnManager was removed)
// - parseColourString()/randomColour() -> not needed here; colour
//   resolution lives in colour.js (randomColour) since config.player_colours
//   is now [r,g,b] arrays directly, no string parsing required
// - loadSpriteSafe() -> p5-only (uses loadImage), never applicable server-side

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Shared by GameLogic.playerOrder(). Finds the next id in playerIDs,
// starting at fromIndex, that's still in remainingTanks. Returns
// { id, index } so callers can decide what to mutate with the index.
function findNextAlive(playerIDs, remainingTanks, fromIndex) {
  let idx = fromIndex;
  let guard = 0; // safety net against an all-dead edge case looping forever
  while (guard++ < 1000) {
    const candidate = playerIDs[idx % playerIDs.length];
    if (remainingTanks.includes(candidate)) {
      return { id: candidate, index: idx };
    }
    idx++;
  }
  return { id: playerIDs[fromIndex % playerIDs.length], index: fromIndex };
}

module.exports = { clamp, findNextAlive };
