// rooms/logic/constants.js
module.exports = {
  FPS: 30,
  INITIAL_PARACHUTES: 1,

  GRAVITY: 3.6,
  WIND_SCALE: 0.03,
  DRAG_COEFF: 0.15, // tune by playtesting — this is a guess, not derived

  CELLSIZE: 32,
  WIDTH: 864,
  HEIGHT: 640,
  GRID_HEIGHT: 20,
  get GRID_WIDTH() { return Math.floor(this.WIDTH / this.CELLSIZE) + 1; },  // 28

  TURRET_LENGTH: 15,

  ANIMATION_TICKS: 6
};