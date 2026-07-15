// rooms/logic/Tank.js
// Port of client Tank.js. Same simulation rules — tick() logic is
// unchanged. What's removed: draw() and deployParachute() (both pure
// rendering, called nowhere else in tick()'s control flow, safe to drop).
// Client's own Tank.js keeps those for rendering, driven by this tank's
// synced `falling`/`parachute` fields instead of calling them itself.

const { Board } = require('./Board');
const { Projectile } = require('./Projectile');
const { clamp } = require('./utils');
const { radians, sin, cos } = require('./mathUtils');
const { INITIAL_PARACHUTES } = require('./constants');
const { randomColour } = require('./colour');

class Tank {
  static TURRET_LENGTH = 15;

  constructor(playerId, x, y, game) {
    this.player = playerId;
    this.x = x;
    this.y = y;

    this.projectile = new Projectile();
    this.colour = [0, 0, 0];

    this.fuel = 250;
    this.parachute = INITIAL_PARACHUTES;
    this.health = 100;
    this.power = 50;
    this.score = 0;

    this.rotateLeftFlag = false;
    this.rotateRightFlag = false;
    this.moveLeftFlag = false;
    this.moveRightFlag = false;
    this.morePowerFlag = false;
    this.lessPowerFlag = false;
    this.falling = false;

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

  updatePosition(game) {
    this.y = game.terrainPosition[clamp(Math.floor(this.x), 0, game.terrainPosition.length - 1)];
    this.adjustTurret(this.turretAngle);
  }

  adjustTurret(angle) {
    const rad = radians(angle);
    this.turret[0] = this.x + Math.floor(Tank.TURRET_LENGTH * sin(rad));
    this.turret[1] = this.y - 6 - Math.floor(Tank.TURRET_LENGTH * cos(rad));
  }

  // colourValue is [r,g,b] from config.player_colours, or anything falsy/
  // invalid (e.g. a layout letter with no config entry) falls back to a
  // random colour — mirrors the old parseColourString ?? randomColour()
  // pattern, just without string parsing since config now stores arrays.
  setColour(colourValue) {
    this.colour = Array.isArray(colourValue) && colourValue.length === 3
      ? colourValue
      : randomColour();
    this.projectile.setColour(this.colour);
  }

  setHealth(delta) {
    this.health += delta;
  }

  setPower(power) {
    this.power = power;
  }

  addScore(delta) {
    this.score += delta;
  }

  selfDestruct(game, health) {
    this.projectile.explosion.setExplosionForTank(this, health);
    this.projectile.explosion.calcDamage(game, this);
    this.projectile.explosion.updateTerrain(game);

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

    // only 1 tank left -> level (or game) over
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

  fall() {
    this.stopAdjustment();
    this.falling = true;
  }

  isFalling() {
    return this.falling;
  }

  /* input intents — set by TankRoom in response to client messages */
  rotateLeft() { this.rotateLeftFlag = true; }
  rotateRight() { this.rotateRightFlag = true; }
  moveLeft() { this.moveLeftFlag = true; }
  moveRight() { this.moveRightFlag = true; }
  morePower() { this.morePowerFlag = true; }
  lessPower() { this.lessPowerFlag = true; }

  // power-ups
  repair() {
    const add = 20, cost = 20;
    if (this.score >= cost && this.health + add <= 100) {
      this.health += add;
      this.score -= cost;
    }
  }

  addFuel() {
    const add = 200, cost = 10;
    if (this.score >= cost) {
      this.fuel += add;
      this.score -= cost;
    }
  }

  addParachute() {
    const add = 1, cost = 15;
    if (this.score >= cost) {
      this.parachute += add;
      this.score -= cost;
    }
  }

  stopAdjustment() {
    this.rotateLeftFlag = false;
    this.rotateRightFlag = false;
    this.moveLeftFlag = false;
    this.moveRightFlag = false;
    this.morePowerFlag = false;
    this.lessPowerFlag = false;
  }

  tick(game, dt) {
    const turretPsDeg = 3 * (180 / Math.PI); // matches client's degrees(3)
    const tankPs = 60;              // tank px/sec
    const powerPs = 36;             // power/sec

    if (!this.falling) {
      if (this.rotateLeftFlag) {
        const delta = turretPsDeg * dt;
        if (this.turretAngle > -90) {
          this.turretAngle -= delta;
          if (this.turretAngle <= -90) this.turretAngle = -90;
          this.adjustTurret(this.turretAngle);
        }
      } else if (this.rotateRightFlag) {
        const delta = turretPsDeg * dt;
        if (this.turretAngle < 90) {
          this.turretAngle += delta;
          if (this.turretAngle >= 90) this.turretAngle = 90;
          this.adjustTurret(this.turretAngle);
        }
      } else if (this.moveLeftFlag) {
        const delta = tankPs * dt;
        if (this.x - delta >= 0 && this.fuel - delta >= 0) {
          this.x -= delta;
          this.fuel -= delta;
          this.updatePosition(game);
          if (this.y >= Board.HEIGHT) this.selfDestruct(game, 1);
        }
      } else if (this.moveRightFlag) {
        const delta = tankPs * dt;
        if (this.x + delta < Board.WIDTH && this.fuel - delta >= 0) {
          this.x += delta;
          this.fuel -= delta;
          this.updatePosition(game);
          if (this.y >= Board.HEIGHT) this.selfDestruct(game, 1);
        }
      } else if (this.morePowerFlag) {
        const delta = powerPs * dt;
        if (this.power + delta <= this.health) this.power += delta;
      } else if (this.lessPowerFlag) {
        const delta = powerPs * dt;
        if (this.power - delta >= 0) this.power -= delta;
      }
    } else {
      const fallPs = this.parachute === 0 ? 120 : 60;
      const delta = fallPs * dt;
      const groundY = game.terrainPosition[clamp(Math.floor(this.x), 0, game.terrainPosition.length - 1)];

      if (this.y + delta <= groundY && this.y + delta <= Board.HEIGHT) {
        // parachute deploy is now a pure render-side inference from
        // (falling && parachute > 0) on the client — no image()/triangle()
        // call needed here.
        this.y += delta;
        if (this.parachute === 0) {
          this.setHealth(-delta);
          if (this.health < this.power) this.setPower(this.health);
        }
      } else {
        if (this.y > Board.HEIGHT) {
          this.y = Board.HEIGHT;
          this.selfDestruct(game, 1);
        } else if (this.y > groundY) {
          if (this.parachute === 0) this.setHealth(this.y - groundY);
          this.y = groundY;
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
