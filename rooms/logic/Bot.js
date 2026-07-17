// rooms/logic/Bot.js
//
// A Bot "plays" exactly like a real client would: it holds turret
// rotate/power flags on its own Tank over successive simulation ticks
// (same as Tank.tick() expects from a real player), then fires. It never
// mutates Tank fields directly except through the same setter methods
// TankRoom's "action" handler already calls (rotateLeft/rotateRight/
// morePower/lessPower/stopAdjustment) — so nothing about Tank.js or the
// turn/scoring bookkeeping in GameLogic/Tank needs to change.
//
// The "fairness" trick: the bot DOES know every tank's real x/y (same as
// any spectator would). What keeps it from hitting every shot is that its
// solver plans against a *misjudged* wind value and adds human-like
// execution error to the final angle/power — same as a person eyeballing
// the wind arrow and pushing buttons for roughly-the-right amount of time.
// Aiming quality is controlled entirely by DIFFICULTY_PRESETS below.

const { Board } = require('./Board');
const { clamp } = require('./utils');
const { radians, sin, cos } = require('./mathUtils');
const { FPS, GRAVITY, WIND_SCALE, DRAG_COEFF, TURRET_LENGTH } = require('./constants');

// Must stay numerically in sync with Projectile.js's tick() — this is a
// headless re-implementation of the same physics so we can "test-fire"
// thousands of candidate shots per turn without touching the real
// Projectile (which has side effects: damage calc + terrain carving).


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

// Approximates Tank.adjustTurret() for a *candidate* angle we haven't
// actually turned to yet, so the solver aims from the true muzzle point
// rather than the tank's body position.
function turretOrigin(tankX, tankY, turretAngleDeg) {
  const rad = radians(turretAngleDeg);
  return [
    tankX + Math.floor(TURRET_LENGTH * sin(rad)),
    tankY - 6 - Math.floor(TURRET_LENGTH * cos(rad)),
  ];
}

function gaussian(sigma) {
  if (sigma <= 0) return 0;
  const u1 = Math.random() || 1e-9;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sigma;
}

// angleError/powerError/windError are gaussian std-devs (in degrees /
// power-points / wind-units). correctionRate + memoryDecay control how
// much a bot "learns" the wind over the course of a level (see
// _effectiveWindError below) rather than misjudging it identically every
// single turn.
const DIFFICULTY_PRESETS = {
  easy:   { angleError: 7,   powerError: 9,   windError: 14, memoryDecay: 0.9  },
  medium: { angleError: 3.5, powerError: 4.5, windError: 7,  memoryDecay: 0.75 },
  hard:   { angleError: 1.5, powerError: 2,   windError: 3,  memoryDecay: 0.55 },
  expert: { angleError: 0.4, powerError: 0.6, windError: 0.5, memoryDecay: 0.3 },
};

class Bot {
  constructor(letter, difficulty = 'medium') {
    this.letter = letter;
    this.preset = DIFFICULTY_PRESETS[difficulty] ?? DIFFICULTY_PRESETS.medium;

    this.state = 'idle'; // idle -> aiming -> powering -> firing
    this.plan = null;    // { angle, power, targetLetter }
    this.turnsTaken = 0; // grows within a level, shrinks bot's wind error over time
    this._levelSeen = null;

    this._ANGLE_EPS = 1.2;  // degrees; matches ~1 tick of rotation at turretPsDeg*dt
    this._POWER_EPS = 1.2;  // power-points; matches ~1 tick of powerPs*dt
  }

  // Call once, the instant this bot's turn begins (currentPlayer === this.letter).
  startTurn(game) {
    if (game.currentLevel !== this._levelSeen) {
      this._levelSeen = game.currentLevel;
      this.turnsTaken = 0; // fresh level = fresh terrain/wind pattern, forget "learned" wind
    }

    const maybePreShot = this._maybeSpendScore(game);
    void maybePreShot; // repair/fuel/parachute purchases, see below — fire-and-forget, doesn't block aiming

    this.plan = this._planShot(game);
    this.state = this.plan ? 'aiming' : 'idle'; // no living target = nothing to do (shouldn't normally happen)
  }

  // Call every simulation tick while it's this bot's turn (same dt as
  // Tank.tick(game, dt) already receives). Returns true exactly once, on
  // the tick it wants TankRoom to actually fire.
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

  _pickTarget(game) {
    const me = game.players.get(this.letter);
    const candidates = game.remainingTanks
      .filter((l) => l !== this.letter)
      .map((l) => game.players.get(l))
      .filter(Boolean);

    if (candidates.length === 0) return null;

    // Weighted random pick: closer + lower-health targets are more likely,
    // but it's never deterministic — a bot that always snipes the weakest
    // player every single time reads as unfair even when each shot is fair.
    const weights = candidates.map((t) => {
      const dist = Math.max(1, Math.abs(t.x - me.x));
      const healthFactor = 1 + (100 - t.health) / 150;
      return (1 / dist) * healthFactor;
    });

    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < candidates.length; i++) {
      r -= weights[i];
      if (r <= 0) return candidates[i];
    }
    return candidates[candidates.length - 1];
  }

  _effectiveWindError() {
    // Bot "settles in" on the wind over the course of a level: its
    // misjudgment shrinks geometrically with turns taken, floored so it
    // never becomes perfectly omniscient even late in a long level.
    const floor = this.preset.windError * 0.25;
    const decayed = this.preset.windError * Math.pow(this.preset.memoryDecay, this.turnsTaken);
    return Math.max(floor, decayed);
  }

  _planShot(game) {
    const target = this._pickTarget(game);
    if (!target) return null;

    const me = game.players.get(this.letter);
    const maxPower = clamp(me.health, 5, 100); // power is capped by health, see Tank.morePower()
    const perceivedWind = game.wind + gaussian(this._effectiveWindError());

    // Aim point: target's turret roughly, i.e. a little above tank body,
    // not ground level under it.
    const targetX = target.x;
    const targetY = target.y - 10;

    const evaluateAngle = (angleDeg) => {
      const [ox, oy] = turretOrigin(me.x, me.y, angleDeg);
      let lo = 5, hi = maxPower, best = null;

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
      angle: clamp(best.angle + gaussian(this.preset.angleError), -90, 90),
      power: clamp(best.power + gaussian(this.preset.powerError), 5, maxPower),
    };
  }

  // Cheap, optional pre-turn utility spending — mirrors what a sensible
  // human would do with idle score before aiming. Doesn't consume the
  // turn (only "fire" does, per TankRoom's "action" handler).
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