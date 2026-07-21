// shared/constants.js
//
// Tunable/shared values used across the server simulation logic. Synced
// verbatim into the client repo by scripts/sync-shared.js — anything
// added here is visible to the client too, so keep it to facts both
// sides need to agree on, not server-only implementation details.

const Constants = {
  // --- Simulation timing --------------------------------------------------
  FPS: 30,
  ANIMATION_TICKS: 6,

  // --- Room / session -------------------------------------------------------
  MAX_PLAYERS: 4, // room capacity — TankRoom.js's LETTERS (board-letter labeling,
                   // server-only) derives from this; the client only needs the count.

  // --- Physics --------------------------------------------------------------
  GRAVITY: 3.6,
  WIND_SCALE: 0.03,
  DRAG_COEFF: 0.15, // tune by playtesting — this is a guess, not derived

  // --- Board geometry ---------------------------------------------------
  CELLSIZE: 32,
  WIDTH: 864,
  HEIGHT: 640,
  GRID_HEIGHT: 20,
  get GRID_WIDTH() { return Math.floor(this.WIDTH / this.CELLSIZE) + 1; },  // 28

  // --- Tank / gameplay tuning ---------------------------------------------
  INITIAL_PARACHUTES: 1,
  TURRET_LENGTH: 15,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Constants;
}