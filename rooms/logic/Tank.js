// rooms/logic/Tank.js
//
// One player's tank: stats, input-intent flags set by TankRoom, and the
// per-tick simulation that drives them. Depends on shared/constants,
// utils, Board, and Projectile.

const { INITIAL_PARACHUTES, TURRET_LENGTH, TURRET_DEG_PER_SEC, POWER_PER_SEC, TANK_PS } = require('../../shared/constants');
const { clamp, radians, sin, cos, randomColour, isValidRGB } = require('./utils');
const { Board } = require('./Board');
const { Projectile } = require('./Projectile');

/**
 * Tank represents one player's tank: position, stats, input intents set
 * by TankRoom, and the per-tick simulation (turret rotation, movement,
 * falling, self-destruct) that drives them.
 */
class Tank {
  /** Turret arm length in pixels, used by adjustTurret(). */
  static TURRET_LENGTH = TURRET_LENGTH;

  /**
   * @param {string} playerId - This tank's player/session id.
   * @param {number} x - Initial x position.
   * @param {number} y - Initial y position.
   * @param {GameLogic} game - The active game, used to carry over score/parachutes from a prior level.
   */
  constructor(playerId, x, y, game) {
    this.player = playerId;
    this.x = x;
    this.y = y;

    this.projectile = new Projectile();
    this.colour = [0, 0, 0];

    // --- Stats ---
    this.fuel = 250;
    this.parachute = INITIAL_PARACHUTES;
    this.health = 100;
    this.power = 50;
    this.score = 0;

    // --- Input intents, set by TankRoom in response to client messages ---
    this.rotateLeftFlag = false;
    this.rotateRightFlag = false;
    this.moveLeftFlag = false;
    this.moveRightFlag = false;
    this.morePowerFlag = false;
    this.lessPowerFlag = false;
    this.falling = false;

    // --- Turret ---
    this.turretAngle = 0;
    this.turret = [0, 0];

    // carries score/parachutes over from the previous level - see the
    // comment in GameLogic.generateLevel() for why this reads *last*
    // level's arrays (they haven't been replaced yet at this point)
    const idx = game.playerIDs.indexOf(playerId);
    if (idx !== -1) {
      this.score = game.playerScores[idx] ?? 0;
      this.parachute = game.playerParachutes[idx] ?? INITIAL_PARACHUTES;
    }

    this.adjustTurret(this.turretAngle);
  }

  /**
   * Snap this tank onto the terrain height at its current x column, and
   * recompute the turret tip position to match. Used after horizontal
   * movement, since the ground height can differ at the new x.
   *
   * @param {GameLogic} game - The active game, providing terrainPosition.
   */
  updatePosition(game) {
    this.y = game.terrainPosition[clamp(Math.floor(this.x), 0, game.terrainPosition.length - 1)];
    this.adjustTurret(this.turretAngle);
  }

  /**
   * Recompute the turret tip's world position from the current turret
   * angle. NOTE: both turret[0] AND turret[1] vary with angle here (via
   * sin/cos respectively) — turret[1] is not a fixed anchor offset from
   * tank.y. It ranges from `y - 6` (turret horizontal, angle ±90°) to
   * `y - 6 - TURRET_LENGTH` (turret straight up, angle 0°). Relevant to
   * Projectile.setFire()'s bounds check, which only validates turret[0].
   *
   * @param {number} angle - Turret angle in degrees.
   */
  adjustTurret(angle) {
    const rad = radians(angle);
    this.turret[0] = this.x + Math.floor(Tank.TURRET_LENGTH * sin(rad));
    this.turret[1] = this.y - 6 - Math.floor(Tank.TURRET_LENGTH * cos(rad));
  }

  /**
   * Set this tank's colour, falling back to a random colour for invalid
   * input. Shares its validation (isValidRGB) with resolvePlayerColour()
   * in utils.js, so both places agree on what counts as a valid colour.
   *
   * colourValue is [r,g,b] from config.player_colours, or anything falsy/
   * invalid (e.g. a layout letter with no config entry) falls back to a
   * random colour.
   *
   * @param {[number, number, number]} colourValue - An [r, g, b] triple, or an invalid value to trigger the random fallback.
   */
  setColour(colourValue) {
    this.colour = isValidRGB(colourValue) ? colourValue : randomColour();
    this.projectile.setColour(this.colour);
  }

  /**
   * Apply a health delta (positive to heal, negative to damage).
   * @param {number} delta - Amount to add to current health.
   */
  setHealth(delta) {
    this.health += delta;
  }

/**
 * Set shot power, clamped to [0, health] — power can never exceed
 * remaining health, or go negative.
 * @param {number} power - Desired power value (will be clamped).
 */
setPower(power) {
  this.power = clamp(power, 0, this.health);
}


  /**
   * Apply a score delta (positive to award, negative to spend).
   * @param {number} delta - Amount to add to current score.
   */
  addScore(delta) {
    this.score += delta;
  }

  /**
   * Destroy this tank: trigger its explosion (damage/terrain), remove it
   * from the round, and progress the game if it was the last tank
   * standing.
   *
   * NOTE: if two tanks both reach health <= 0 in the same GameLogic tick
   * (e.g. both fall from the same terrain collapse), whichever calls
   * selfDestruct() first will see `remainingTanks.length === 1` and
   * record the OTHER (also-dying) tank as the winner before it too dies.
   * Edge case, not handled — flagged pending GameLogic.js's tick order.
   *
   * @param {GameLogic} game - The active game.
   * @param {number} health - 0 if died from damage (small self-destruct blast);
   *   1 if died from falling off the map (a sentinel, not a real health value —
   *   distinguishes the death cause so Explosion.setExplosionForTank picks the right blast radius).
   */
  selfDestruct(game, health) {
    // --- Trigger the death blast (damage + terrain) ---
    this.projectile.explosion.setExplosionForTank(this, health);
    this.projectile.explosion.calcDamage(game, this);
    this.projectile.explosion.updateTerrain(game);
    this.projectile.explosion.active = false;

    // --- Persist final score/parachutes and remove from the round ---
    const idx = game.playerIDs.indexOf(this.player);
    if (idx !== -1) {
      game.playerScores[idx] = this.score;
      game.playerParachutes[idx] = this.parachute;

      const ri = game.remainingTanks.indexOf(this.player);
      if (ri !== -1) game.remainingTanks.splice(ri, 1);

      if (game.currentPlayer === this.player) {
        game.playerOrder();
      }
    }

    // --- Only 1 tank left -> level (or game) over ---
    if (game.remainingTanks.length === 1) {
      const lastId = game.remainingTanks[0];
      const lastIdx = game.playerIDs.indexOf(lastId);
      const lastTank = game.players.get(lastId);

      if (lastIdx !== -1 && lastTank) {
        game.playerScores[lastIdx] = lastTank.score;
        game.playerParachutes[lastIdx] = lastTank.parachute;
      }

      if (game.currentLevel < game.config.levels.length) {
        game.levelSwitch();
      } else {
        game.getWinner();
        game.gameEnded = true;
      }
    }
  }

  /**
   * Begin falling: cancels any queued input (rotate/move/power) so it
   * can't fire off unexpectedly once landed, then sets falling = true.
   * Called externally (e.g. by GameLogic) when terrain collapses under
   * a stationary tank.
   */
  fall() {
    this.stopAdjustment();
    this.falling = true;
  }

  /** @returns {boolean} Whether this tank is currently falling. */
  isFalling() {
    return this.falling;
  }

  // --- Input intents — set by TankRoom in response to client messages ---
  /** Queue a turret rotate-left for the next tick(). */
  rotateLeft() { this.rotateLeftFlag = true; }
  /** Queue a turret rotate-right for the next tick(). */
  rotateRight() { this.rotateRightFlag = true; }
  /** Queue a move-left for the next tick(). */
  moveLeft() { this.moveLeftFlag = true; }
  /** Queue a move-right for the next tick(). */
  moveRight() { this.moveRightFlag = true; }
  /** Queue a power-increase for the next tick(). */
  morePower() { this.morePowerFlag = true; }
  /** Queue a power-decrease for the next tick(). */
  lessPower() { this.lessPowerFlag = true; }

  // --- Power-ups (score-for-resource trades) ---

  /** Spend score to heal, up to a 100 health cap. No-ops if unaffordable or already near-full health. */
  repair() {
    const add = 20, cost = 20;
    if (this.score >= cost && this.health + add <= 100) {
      this.health += add;
      this.score -= cost;
    }
  }

  /** Spend score for fuel. Uncapped (unlike repair()'s 100-health cap). No-ops if unaffordable. */
  addFuel() {
    const add = 200, cost = 10;
    if (this.score >= cost) {
      this.fuel += add;
      this.score -= cost;
    }
  }

  /** Spend score for an extra parachute. Uncapped. No-ops if unaffordable. */
  addParachute() {
    const add = 1, cost = 15;
    if (this.score >= cost) {
      this.parachute += add;
      this.score -= cost;
    }
  }

  /** Clear all queued input-intent flags (rotate/move/power). Does not affect `falling`. */
  stopAdjustment() {
    this.rotateLeftFlag = false;
    this.rotateRightFlag = false;
    this.moveLeftFlag = false;
    this.moveRightFlag = false;
    this.morePowerFlag = false;
    this.lessPowerFlag = false;
  }

  /**
   * Advance this tank by one tick: process one queued input intent (only
   * one per tick, in rotate > move > power priority order) while grounded,
   * or advance the fall simulation while falling. Self-destructs if health
   * reaches 0 or the tank falls off the bottom of the map.
   *
   * @param {GameLogic} game - The active game.
   * @param {number} dt - Elapsed time this tick, in seconds.
   */
  tick(game, dt) {
    if (!this.falling) {
      // --- Grounded: process at most one queued input intent this tick ---
      if (this.rotateLeftFlag) {
        const delta = TURRET_DEG_PER_SEC * dt;
        if (this.turretAngle > -90) {
          this.turretAngle -= delta;
          if (this.turretAngle <= -90) this.turretAngle = -90;
          this.adjustTurret(this.turretAngle);
        }
      } else if (this.rotateRightFlag) {
        const delta = TURRET_DEG_PER_SEC * dt;
        if (this.turretAngle < 90) {
          this.turretAngle += delta;
          if (this.turretAngle >= 90) this.turretAngle = 90;
          this.adjustTurret(this.turretAngle);
        }
      } else if (this.moveLeftFlag) {
        const delta = TANK_PS * dt;
        if (this.x - delta >= 0 && this.fuel - delta >= 0) {
          this.x -= delta;
          this.fuel -= delta;
          this.updatePosition(game);
          if (this.y >= Board.HEIGHT) this.selfDestruct(game, 1);
        }
      } else if (this.moveRightFlag) {
        const delta = TANK_PS * dt;
        if (this.x + delta < Board.WIDTH && this.fuel - delta >= 0) {
          this.x += delta;
          this.fuel -= delta;
          this.updatePosition(game);
          if (this.y >= Board.HEIGHT) this.selfDestruct(game, 1);
        }
      } else if (this.morePowerFlag) {
        const delta = POWER_PER_SEC * dt;
        this.setPower(this.power + delta);
      } else if (this.lessPowerFlag) {
        const delta = POWER_PER_SEC * dt;
        this.setPower(this.power - delta);
      }
    } else {
      // --- Falling: advance the fall, or land if this tick would overshoot ---
      const fallPs = this.parachute === 0 ? 120 : 60;
      const delta = fallPs * dt;
      const groundY = game.terrainPosition[clamp(Math.floor(this.x), 0, game.terrainPosition.length - 1)];

      if (this.y + delta <= groundY && this.y + delta <= Board.HEIGHT) {
        // Still falling — projected position hasn't reached the ground or the bottom of the map yet.
        this.y += delta;
        if (this.parachute === 0) {
          this.setHealth(-delta);
          this.setPower(this.power);
        }
      } else {
        // Compares the projected `this.y + delta` against Board.HEIGHT/groundY
        if (this.y + delta > Board.HEIGHT) {
          this.y = Board.HEIGHT;
          this.selfDestruct(game, 1);
        } else if (this.y + delta > groundY) {
          if (this.parachute === 0) this.setHealth(this.y + delta - groundY);
          this.y = groundY;
          this.setPower(this.power);
        }

        game.damagedTanks.delete(this);

        if (this.parachute > 0) this.parachute -= 1;
        this.stopAdjustment();
        this.falling = false;
      }
      this.adjustTurret(this.turretAngle);
    }

    if (this.health <= 0) {
      this.selfDestruct(game, 0);
    }
  }
}

module.exports = { Tank };