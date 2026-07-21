// rooms/logic/Bot.js
//
// AI opponent: aims via a headless physics simulation, then drives its
// Tank through the same input-intent flags a human client's actions would
// set. Depends on shared/constants, utils, and Board.

const { FPS, GRAVITY, WIND_SCALE, DRAG_COEFF, TURRET_LENGTH } = require('../../shared/constants');
const { clamp, radians, sin, cos } = require('./utils');
const { Board } = require('./Board');

// --- Headless physics (mirrors Projectile.js) -----------------------------
// Must stay numerically in sync with Projectile.js's tick() — this is a
// headless re-implementation of the same physics so we can "test-fire"
// thousands of candidate shots per turn without touching the real
// Projectile (which has side effects: damage calc + terrain carving).

/**
 * Simulate one candidate shot's flight path without any side effects
 * (no damage, no terrain carving), stepping the same physics as
 * Projectile.tick() until it lands, vanishes off-screen, or times out.
 *
 * @param {number} originX - Muzzle x position to fire from.
 * @param {number} originY - Muzzle y position to fire from.
 * @param {number} turretAngleDeg - Turret angle in degrees (same convention as Tank.turretAngle).
 * @param {number} power - Shot power.
 * @param {number} wind - Wind value to simulate against (the bot's *perceived*
 *   wind, not necessarily game.wind — see _planShot's perceivedWind).
 * @param {number[]} terrainPosition - Pixel-indexed terrain heightmap (game.terrainPosition).
 * @param {number} [maxTicks] - Safety cap on simulation steps.
 * @returns {{hit: boolean, x: number, y: number}} Where the shot ended up,
 *   and whether it landed on terrain (`hit: true`) or vanished off-screen (`hit: false`).
 */
function simulateShot(originX, originY, turretAngleDeg, power, wind, terrainPosition, maxTicks = 1500) {
  const angle = 270 + turretAngleDeg;
  const init = power * 0.08 + 1;

  let velX = init * cos(radians(angle));
  let velY = -init * sin(radians(angle));
  let x = originX;
  let y = originY;

  const windTargetVelX = wind * WIND_SCALE;

  for (let i = 0; i < maxTicks; i++) {
    const terrainX = clamp(Math.floor(x), 0, terrainPosition.length - 1);

    if (y >= terrainPosition[terrainX]) {
      return { hit: true, x, y }; // landed on terrain (or a tank standing on it)
    }
    if (x <= 5 || y <= 5 || x >= Board.WIDTH - 5 || y >= Board.HEIGHT - 5) {
      return { hit: false, x, y }; // vanished off-screen, exactly like a real shot would
    }

    velX += (DRAG_COEFF * (windTargetVelX - velX)) / FPS;
    x += velX;
    y -= velY;
    velY -= GRAVITY / FPS;
  }
  return { hit: false, x, y };
}

/**
 * Compute a candidate turret's muzzle position — mirrors Tank.adjustTurret(),
 * but for an angle the tank hasn't actually turned to yet, so the solver
 * aims from the true muzzle point rather than the tank's body position.
 *
 * @param {number} tankX - Tank body x position.
 * @param {number} tankY - Tank body y position.
 * @param {number} turretAngleDeg - Candidate turret angle in degrees.
 * @returns {[number, number]} [muzzleX, muzzleY].
 */
function turretOrigin(tankX, tankY, turretAngleDeg) {
  const rad = radians(turretAngleDeg);
  return [
    tankX + Math.floor(TURRET_LENGTH * sin(rad)),
    tankY - 6 - Math.floor(TURRET_LENGTH * cos(rad)),
  ];
}

/**
 * Sample a gaussian-distributed random offset (Box-Muller transform),
 * used throughout Bot for human-like execution/aim error.
 *
 * @param {number} sigma - Standard deviation of the desired distribution.
 *   Values <= 0 short-circuit to exactly 0 (no error).
 * @param {() => number} rng - Uniform [0, 1) random source. Required (no
 *   Math.random default) so every call site is forced to thread through
 *   game.rng — keeps bot decisions reproducible from the same seed as
 *   wind, per GameLogic's replay/parity contract.
 * @returns {number} A gaussian sample with mean 0 and the given std-dev.
 */
function gaussian(sigma, rng) {
  if (sigma <= 0) return 0;
  const u1 = rng() || 1e-9;
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sigma;
}

// --- Difficulty tuning -----------------------------------------------------
// angleError/powerError/windError are gaussian std-devs (in degrees /
// power-points / wind-units) fed into gaussian() above. memoryDecay
// controls how much a bot "learns" the wind over the course of a level
// (see _effectiveWindError below) rather than misjudging it identically
// every single turn.
const DIFFICULTY_PRESETS = {
  easy:   { angleError: 7,   powerError: 9,   windError: 14, memoryDecay: 0.9  },
  medium: { angleError: 3.5, powerError: 4.5, windError: 7,  memoryDecay: 0.75 },
  hard:   { angleError: 1.5, powerError: 2,   windError: 3,  memoryDecay: 0.55 },
  expert: { angleError: 0.4, powerError: 0.6, windError: 0.5, memoryDecay: 0.3 },
};

/**
 * Bot drives one AI-controlled Tank through a turn by setting the exact
 * same input-intent flags a real client's actions would (rotateLeft/
 * rotateRight/morePower/lessPower), across successive startTurn()/tick()
 * calls from TankRoom — see the file header for the full "fairness" design.
 */
class Bot {
  /**
   * @param {string} letter - The board letter (Tank.player id) this bot controls.
   * @param {'easy'|'medium'|'hard'|'expert'} [difficulty] - Key into
   *   DIFFICULTY_PRESETS; falls back to 'medium' for an unrecognized value.
   */
  constructor(letter, difficulty = 'medium') {
    this.letter = letter;
    this.preset = DIFFICULTY_PRESETS[difficulty] ?? DIFFICULTY_PRESETS.medium;

    // State machine: idle -> aiming -> powering -> (fire, back to idle).
    // There's no persisted 'firing' state — firing is the instantaneous
    // powering->idle transition on the tick tick() returns true.
    this.state = 'idle';
    this.plan = null;    // { angle, power, targetLetter }, set by startTurn() via _planShot()
    this.turnsTaken = 0; // grows within a level, shrinks bot's wind error over time
    this._levelSeen = null; // last game.currentLevel seen, used to reset turnsTaken on a new level

    this._ANGLE_EPS = 1.2;  // degrees; matches ~1 tick of rotation at turretPsDeg*dt
    this._POWER_EPS = 1.2;  // power-points; matches ~1 tick of powerPs*dt
  }

  // --- Turn lifecycle (called by TankRoom) ----------------------------

  /**
   * Begin this bot's turn: picks a target and computes an angle/power
   * plan (via _planShot()), and optionally spends idle score on repairs/
   * fuel first. Call once, the instant this bot's turn begins
   * (game.currentPlayer === this.letter) — subsequent per-tick progress
   * toward the plan happens in tick().
   *
   * @param {GameLogic} game - The active game.
   */
  startTurn(game) {
    if (game.currentLevel !== this._levelSeen) {
      this._levelSeen = game.currentLevel;
      this.turnsTaken = 0; // fresh level = fresh terrain/wind pattern, forget "learned" wind
    }

    this._maybeSpendScore(game); // repair/fuel/parachute purchases, see below — doesn't block aiming

    this.plan = this._planShot(game);
    this.state = this.plan ? 'aiming' : 'idle'; // no living target = nothing to do (shouldn't normally happen)
  }

  /**
   * Advance this bot's plan by one simulation tick: nudges the turret
   * toward the planned angle, then the power toward the planned power,
   * one queued input-intent flag at a time (same as Tank.tick() expects).
   * Call every tick while it's this bot's turn, with the same dt Tank.tick()
   * receives.
   *
   * @param {GameLogic} game - The active game.
   * @param {number} dt - Elapsed time this tick, in seconds.
   * @returns {boolean} True exactly once, on the tick TankRoom should
   *   actually fire this tank (same code path as a real "fire" action).
   */
  tick(game, dt) {
    if (this.state === 'idle' || !this.plan) return false;

    const tank = game.players.get(this.letter);
    if (!tank) { this.state = 'idle'; return false; }

    if (this.state === 'aiming') {
      const diff = this.plan.angle - tank.turretAngle;
      tank.stopAdjustment();
      if (Math.abs(diff) <= this._ANGLE_EPS) {
        this.state = 'powering';
      } else if (diff > 0) {
        tank.rotateRight();
      } else {
        tank.rotateLeft();
      }
      return false;
    }

    if (this.state === 'powering') {
      const diff = this.plan.power - tank.power;
      tank.stopAdjustment();
      if (Math.abs(diff) <= this._POWER_EPS) {
        this.state = 'idle';
        this.turnsTaken++;
        return true; // TankRoom should fire this tank now, same code path as a real "fire" action
      } else if (diff > 0) {
        tank.morePower();
      } else {
        tank.lessPower();
      }
      return false;
    }

    return false;
  }

  // --- target selection + solver -------------------------------------

  /**
   * Choose which living tank to shoot at this turn.
   *
   * Weighted random pick: closer + lower-health targets are more likely,
   * but it's never deterministic — a bot that always snipes the weakest
   * player every single time reads as unfair even when each individual
   * shot is fair.
   *
   * @param {GameLogic} game - The active game.
   * @returns {Tank|null} The chosen target Tank, or null if this bot has
   *   no tank in play, or no other living tanks remain to target.
   */
  _pickTarget(game) {
    const me = game.players.get(this.letter);
    if (!me) return null; // this bot's tank isn't in play — mirrors tick()'s !tank guard

    const candidates = game.remainingTanks
      .filter((l) => l !== this.letter)
      .map((l) => game.players.get(l))
      .filter(Boolean);

    if (candidates.length === 0) return null;

    // closer + lower-health targets get a higher weight
    const weights = candidates.map((t) => {
      const dist = Math.max(1, Math.abs(t.x - me.x));
      const healthFactor = 1 + (100 - t.health) / 150;
      return (1 / dist) * healthFactor;
    });

    const total = weights.reduce((a, b) => a + b, 0);
    let r = game.rng() * total;
    for (let i = 0; i < candidates.length; i++) {
      r -= weights[i];
      if (r <= 0) return candidates[i];
    }
    return candidates[candidates.length - 1];
  }

  /**
   * How much wind error this bot currently applies when planning a shot.
   * Bot "settles in" on the wind over the course of a level: its
   * misjudgment shrinks geometrically with turns taken, floored so it
   * never becomes perfectly omniscient even late in a long level.
   *
   * @returns {number} Standard deviation (in wind-units) to feed into
   *   gaussian() when perturbing game.wind for this shot's planning.
   */
  _effectiveWindError() {
    const floor = this.preset.windError * 0.25;
    const decayed = this.preset.windError * Math.pow(this.preset.memoryDecay, this.turnsTaken);
    return Math.max(floor, decayed);
  }

  /**
   * Plan this turn's shot: pick a target, then binary-search shot power
   * at a coarse-then-fine sweep of turret angles against a headless
   * physics simulation (simulateShot), and finally add gaussian aim/
   * power error on top of the best solution found — the "misjudged wind
   * + human execution error" design described in the file header.
   *
   * @param {GameLogic} game - The active game.
   * @returns {{targetLetter: string, angle: number, power: number}|null}
   *   The plan tick() should chase toward, or null if there's no target
   *   or no reachable solution was found (shouldn't normally happen).
   */
  _planShot(game) {
    const target = this._pickTarget(game);
    if (!target) return null;

    const me = game.players.get(this.letter);
    // Matches Tank.setPower's actual clamp of [0, health] (see Tank.js) — a
    // floor of 5 here would ask the bot to aim for a power tank.setPower()
    // can never reach once health drops below 5, leaving it stuck forever
    // in the 'powering' state chasing an unreachable target.
    const maxPower = clamp(me.health, 0, 100);
    // Preferred minimum shot power (avoids searching absurdly weak shots),
    // but never above maxPower — otherwise a health < 5 tank would get a
    // search range of lo=5 > hi=maxPower and a final clamp(power, 5, maxPower)
    // that always forces power back up to 5, reintroducing the same
    // unreachable-power problem maxPower's clamp above was fixed to avoid.
    const minPower = Math.min(5, maxPower);
    const perceivedWind = game.wind + gaussian(this._effectiveWindError(), game.rng);

    // Aim point: target's turret roughly, i.e. a little above tank body,
    // not ground level under it.
    const targetX = target.x;
    const targetY = target.y - 10;

    // For a fixed angle, binary-search the power that lands closest to
    // the target's (x, y), using the headless simulateShot() to
    // "test-fire" each candidate power without touching the real Projectile.
    const evaluateAngle = (angleDeg) => {
      const [ox, oy] = turretOrigin(me.x, me.y, angleDeg);
      let lo = minPower, hi = maxPower, best = null;

      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        const res = simulateShot(ox, oy, angleDeg, mid, perceivedWind, game.terrainPosition);
        const dx = res.x - targetX;
        const dy = res.y - targetY;
        const err = Math.hypot(dx, dy);

        if (!best || err < best.err) best = { power: mid, err, res };
        if (!res.hit) { hi = mid; continue; } // shot vanished off-screen — back off power
        if (res.x < targetX) lo = mid; else hi = mid;
      }
      return best;
    };

    // Coarse pass across the full turret range, then refine near the winner.
    let best = null;
    for (let a = -85; a <= 85; a += 4) {
      const candidate = evaluateAngle(a);
      if (candidate && (!best || candidate.err < best.err)) best = { ...candidate, angle: a };
    }
    if (best) {
      const centre = best.angle;
      for (let a = centre - 5; a <= centre + 5; a += 1) {
        if (a < -90 || a > 90) continue;
        const candidate = evaluateAngle(a);
        if (candidate && candidate.err < best.err) best = { ...candidate, angle: a };
      }
    }
    if (!best) return null; // no reachable solution found (shouldn't normally happen)

    return {
      targetLetter: target.player,
      angle: clamp(best.angle + gaussian(this.preset.angleError, game.rng), -90, 90),
      power: clamp(best.power + gaussian(this.preset.powerError, game.rng), minPower, maxPower),
    };
  }

  // --- Pre-turn economy ------------------------------------------------

  /**
   * Cheap, optional pre-turn utility spending — mirrors what a sensible
   * human would do with idle score before aiming. Doesn't consume the
   * turn (only "fire" does, per TankRoom's "action" handler).
   *
   * @param {GameLogic} game - The active game.
   * @returns {void}
   */
  _maybeSpendScore(game) {
    const tank = game.players.get(this.letter);
    if (!tank) return;

    if (tank.health <= 55 && tank.score >= 20) {
      tank.repair();
    }
    if (tank.fuel <= 40 && tank.score >= 10) {
      tank.addFuel();
    }
  }
}

module.exports = { Bot, DIFFICULTY_PRESETS };