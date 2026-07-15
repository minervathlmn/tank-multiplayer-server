// rooms/logic/constants.js
// FPS and INITIAL_PARACHUTES used to live only as GameLogic.FPS /
// GameLogic.INITIAL_PARACHUTES static fields. Pulled out here because
// Tank.js and Projectile.js both need them but must NOT require
// GameLogic.js to get them — GameLogic.js requires Tank.js (to create
// tanks), so Tank.js requiring GameLogic.js back would be circular.
// GameLogic.js still exposes static FPS/INITIAL_PARACHUTES for parity,
// sourced from here.

module.exports = {
  FPS: 30,
  INITIAL_PARACHUTES: 1,
};
