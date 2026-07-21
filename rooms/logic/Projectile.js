// rooms/logic/Projectile.js
//
// Port of client Projectile.js. Physics unchanged — this computes the
// real landing point + damage server-side now (per our earlier decision:
// server computes the final result, client just animates toward it).
// draw() removed (pure rendering, client keeps its own visual version).

const { FPS, GRAVITY, WIND_SCALE, DRAG_COEFF } = require('../../shared/constants');
const { clamp, radians, sin, cos } = require('./utils');
const { Board } = require('./Board');
const { Explosion } = require('./Explosion');

/**
 * Projectile represents one tank's in-flight shell: its trajectory,
 * terrain/edge collision, and the Explosion it triggers on impact.
 *
 * Idle/not-flying state is tracked via the explicit `flying` boolean
 * (mirroring Explosion's `active` flag) rather than an off-board
 * position sentinel — `x`/`y` are meaningless while `flying` is false.
 */
class Projectile {
  /** Construct an idle projectile, not currently flying (see class doc). */
  constructor() {
    this.explosion = new Explosion();

    // --- Flight state ---
    this.flying = false;
    this.x = 0;
    this.y = 0;

    // --- Shot parameters, set by setFire() ---
    this.power = 0;
    this.angle = 0;

    // --- Physics state ---
    this.velX = 0;
    this.velY = 0;

    // --- Power-up / rendering ---
    this.doubleBlastRadius = false; // true while the "xtra" power-up is active
    this.colour = [0, 0, 0];
  }

  /**
   * Set this projectile's render colour (matches the firing tank's colour).
   * @param {[number, number, number]} rgb - An [r, g, b] triple, each 0-255.
   */
  setColour(rgb) {
    this.colour = rgb;
  }

  /**
   * Activate the "xtra" power-up for this shot: doubles the next
   * explosion's blast radius (handled in tick()'s hit-terrain branch),
   * at a one-time score cost. No-ops (silently) if the tank can't afford it.
   *
   * NOTE: if this shot never hits terrain (goes off-screen instead),
   * `doubleBlastRadius` is not currently reset to false in the off-screen branch
   * of tick() — see the flag there. That means the doubled radius could
   * carry over into a future shot without xtra() being called again.
   *
   * @param {Tank} tank - The firing tank, charged the power-up's cost.
   */
  // power-up: doubles the next explosion's radius, costs 20 score
  xtra(tank) {
    const cost = 20;
    if (tank.score >= cost) {
      tank.addScore(-cost);
      this.doubleBlastRadius = true;
    }
  }

  /**
   * Launch this projectile from a tank's turret tip, using the tank's
   * current angle/power settings.
   *
   * Silently no-ops if the turret tip's x-coordinate is out of board
   * bounds (turret[1]/y is not currently validated — see flag).
   *
   * @param {GameLogic} game - The active game (unused here, kept for a consistent call signature with tick()).
   * @param {Tank} tank - The firing tank; reads turret, turretAngle, power.
   */
  setFire(game, tank) {
    if (tank.turret[0] > 5 && tank.turret[0] < Board.WIDTH - 5 &&
        tank.turret[1] > 5 && tank.turret[1] < Board.HEIGHT - 5) {
      this.x = tank.turret[0];
      this.y = tank.turret[1];
      this.flying = true;

      // 270 offset points the base angle "up" in screen space (y grows
      // downward), then tank.turretAngle tilts left/right from there.
      this.angle = 270 + tank.turretAngle;
      this.power = tank.power;

      const init = this.power * 0.08 + 1; // initial velocity, range ~1-9px
      this.velX = init * cos(radians(this.angle));
      this.velY = -init * sin(radians(this.angle));
    }
  }

  /**
   * Advance this projectile by one tick: fly under gravity/wind/drag,
   * or resolve on hitting terrain / leaving the screen.
   *
   * @param {GameLogic} game - The active game, providing terrainPosition/wind.
   * @param {Tank} tank - The firing tank, credited with any explosion damage/score.
   */
  tick(game, tank) {
    if (!this.flying) {
      // Idle: not currently in flight.
      this.velX = 0;
      this.velY = 0;
      return;
    }

    const terrainX = clamp(Math.floor(this.x), 0, game.terrainPosition.length - 1);

    if (this.y >= game.terrainPosition[terrainX]) {
      // --- Hit terrain: resolve the shot ---
      this.velX = 0;
      this.velY = 0;

      if (this.doubleBlastRadius) {
        this.explosion.setExplosionForXtra(this);
      } else {
        this.explosion.setExplosionForProjectile(this);
      }

      this.explosion.calcDamage(game, tank);
      this.explosion.updateTerrain(game);
      this.explosion.active = false; // safe here: calcDamage + updateTerrain always run together, right after the explosion triggers above
      // this.explosion.active = false;
      // NOTE: calcDamage + updateTerrain are always called together, right
      // after the explosion triggers above — confirms this is the right
      // spot to add `this.explosion.active = false;` once we're ready to
      // close that loop (not added yet, pending GameLogic.js review).

      this.x = 0;
      this.y = 0;
      this.flying = false;
      this.doubleBlastRadius = false;
    } else if (this.x <= 5 || this.y <= 5 || this.x >= Board.WIDTH - 5 || this.y >= Board.HEIGHT - 5) {
      // --- Left the screen: resolve with no explosion ---
      this.x = 0;
      this.y = 0;
      this.flying = false;
      this.doubleBlastRadius = false;
    } else {
      // --- Flying: integrate one tick of gravity/wind/drag ---
      // Two earlier formulations were tried for wind before this one:
      //   - wind as a flat per-tick offset added directly to position
      //     (never fed into velX, so the shot's velocity itself never
      //     reflected wind)
      //   - wind as a constant acceleration on velX, the same way
      //     gravity drives velY (risks velX growing unbounded on a
      //     long-hanging shot in strong wind)
      // This version instead pulls velX toward a wind-implied target
      // velocity via DRAG_COEFF, so wind visibly affects velocity but
      // asymptotically approaches a bounded terminal value rather than
      // accumulating indefinitely.
      const windTargetVelX = game.wind * WIND_SCALE;
      this.velX += (DRAG_COEFF * (windTargetVelX - this.velX)) / FPS;  // drag pulls velX toward wind
      this.x += this.velX;                                             // no more separate wind term here
      this.y -= this.velY;
      this.velY -= GRAVITY / FPS;
    }
  }
}

module.exports = { Projectile };