// rooms/logic/Explosion.js
//
// Damage + terrain-carving for a single blast. Depends on shared/constants
// and Board.

const { ANIMATION_TICKS } = require('../../shared/constants');
const { Board } = require('./Board');

/**
 * Explosion represents a single blast: a transient circle in world space
 * that, once triggered by `setExplosionFor*`, is used to compute tank
 * damage (`calcDamage`) and carve terrain (`updateTerrain`) for that hit.
 *
 * A single Explosion instance is reused across shots (see the reset note
 * in `setExplosionForProjectile`), rather than allocating a new one per
 * hit — its fields are simply overwritten each time one triggers.
 */
class Explosion {
  /** How many ticks the explosion animation plays for on clients. */
  static ANIMATION_TICKS = ANIMATION_TICKS;

  /**
   * Construct an idle, untriggered Explosion.
   *
   * `active` is the source of truth for whether this explosion currently
   * affects anything — `calcDamage`/`updateTerrain` both no-op while it's
   * false. Position/radius are meaningless until `setExplosionFor*` sets
   * `active = true`, so their idle values don't need to be off-board
   * (previously this relied on parking at (-50,-50) so that the terrain/
   * damage math coincidentally came out inert — that guarantee depended on
   * radius/board-size values staying compatible with it; an explicit flag
   * doesn't have that fragility). Mirrors the `active`/`status` gating
   * used by the client's CosmeticProjectile/CosmeticExplosion.
   */
  constructor() {
    this.x = 0;
    this.y = 0;
    this.radius = 30;
    this.active = false;
  }

  /**
   * Trigger this explosion at a projectile's impact point, using the
   * standard blast radius.
   *
   * @param {Projectile} projectile - The projectile that just hit.
   */
  setExplosionForProjectile(projectile) {
    this.x = projectile.x;
    this.y = projectile.y;
    this.radius = 30; // reset to default - previously could stay at 60/15 from a prior shot
    this.active = true;
  }

  /**
   * Trigger this explosion at a tank's own position (self-destruct).
   * Uses a smaller blast radius when the tank's health has hit exactly 0.
   *
   * @param {Tank} tank - The tank self-destructing.
   * @param {number} health - The tank's health at self-destruct time.
   */
  setExplosionForTank(tank, health) {
    this.x = tank.x;
    this.y = tank.y - 2;

    if (health === 0) {
      this.radius = 15; // self-destruct: smaller blast
    }
    this.active = true;
  }

  /**
   * Trigger this explosion at a projectile's impact point using the
   * "Xtra" power-up's doubled blast radius.
   *
   * @param {Projectile} projectile - The power-up projectile that just hit.
   */
  // power-up: doubled blast radius
  setExplosionForXtra(projectile) {
    this.x = projectile.x;
    this.y = projectile.y;
    this.radius = 60;
    this.active = true;
  }

  /**
   * Apply this explosion's damage to every tank still in the game whose
   * hitbox overlaps the blast circle, and award score to the shooting
   * player for damage dealt (or a kill) to other tanks.
   *
   * Damage falls off linearly from the blast center: full `maxDamage` at
   * distance 0, down to 0 damage exactly at the blast radius edge.
   *
   * @param {GameLogic} game - The active game, providing remainingTanks/players/damagedTanks.
   * @param {Tank} playerTank - The tank that fired the shot (credited with any score).
   */
  calcDamage(game, playerTank) {
    if (!this.active) return;

    for (const id of [...game.remainingTanks]) {
      const tank = game.players.get(id);
      if (!tank) continue;

      // Tank hitbox: a fixed-size box around the tank's anchor point.
      // Width/height (20x8) and the vertical offset (-6/+2, biased
      // upward) approximate the tank sprite's footprint.
      const minX = tank.x - 10;
      const maxX = tank.x + 10;
      const minY = tank.y - 6;
      const maxY = tank.y + 2;

      // Closest point on the hitbox to the blast center (standard
      // circle-vs-AABB clamp). If the center is inside the box, this
      // clamps to the center itself, giving distance === 0.
      const closestX = Math.max(minX, Math.min(this.x, maxX));
      const closestY = Math.max(minY, Math.min(this.y, maxY));
      const distance = Math.sqrt((closestX - this.x) ** 2 + (closestY - this.y) ** 2);

      // NOTE: the second half of this OR is mathematically redundant —
      // when the blast center is inside the box, closestX/Y === this.x/y
      // above, so distance is already 0 and `distance <= this.radius`
      // already holds. Left as-is pending confirmation it's safe to drop.
      if (distance <= this.radius || (this.x > minX && this.x < maxX && this.y > minY && this.y < maxY)) {
        game.damagedTanks.add(tank);

        const damagePercentage = 1 - distance / this.radius;
        const maxDamage = 60; // full damage at blast center, falls off to 0 at the radius edge
        const damage = Math.floor(damagePercentage * maxDamage);

        if (tank !== playerTank) {
          if (tank.health - damage <= 0) {
            playerTank.addScore(tank.health);
          } else {
            playerTank.addScore(damage);
          }
        }

        tank.setHealth(-damage);
        tank.setPower(tank.power); // re-clamp now that health may have dropped
      }
    }
  }

  /**
   * Carve a crater into the terrain heightmap under this explosion, and
   * mark any tank standing above the affected span as damaged (so it can
   * be checked for falling), regardless of whether it took blast damage.
   *
   * Only ever deepens the terrain — never raises it back up — so calling
   * this multiple times (overlapping craters) is safe.
   *
   * @param {GameLogic} game - The active game, providing terrainPosition/playerIDs/players/damagedTanks.
   */
  updateTerrain(game) {
    if (!this.active) return;

    const fromX = Math.max(0, Math.floor(this.x - this.radius));
    const toX = Math.min(Board.WIDTH, Math.floor(this.x + this.radius));

    for (let i = fromX; i <= toX; i++) {
      // Bottom edge of the blast circle at column i (crater profile).
      const currY = Math.floor(Math.sqrt(this.radius ** 2 - (i - this.x) ** 2) + this.y);
      // Only carve deeper: skip if the ground here is already lower
      // (larger y) than this crater would make it.
      if (game.terrainPosition[i] <= currY) {
        game.terrainPosition[i] = currY;
      }
    }

    for (const id of game.playerIDs) {
      const tank = game.players.get(id);
      if (tank && tank.x >= fromX && tank.x <= toX) {
        game.damagedTanks.add(tank);
      }
    }
  }
}

module.exports = { Explosion };