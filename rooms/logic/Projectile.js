// rooms/logic/Projectile.js
// Port of client Projectile.js. Physics unchanged — this computes the
// real landing point + damage server-side now (per our earlier decision:
// server computes the final result, client just animates toward it).
// draw() removed (pure rendering, client keeps its own visual version).

const { Board } = require('./Board');
const { Explosion } = require('./Explosion');
const { clamp } = require('./utils');
const { radians, sin, cos } = require('./mathUtils');
const { FPS } = require('./constants');

class Projectile {
  constructor() {
    this.explosion = new Explosion();

    this.x = -50;
    this.y = -50;

    this.power = 0;
    this.angle = 0;

    this.init = 0;
    this.velX = 0;
    this.velY = 0;

    this.normal = true; // false while the "xtra" power-up is active
    this.colour = [0, 0, 0];
  }

  setColour(rgb) {
    this.colour = rgb;
  }

  // power-up: doubles the next explosion's radius, costs 20 score
  xtra(tank) {
    const cost = 20;
    if (tank.score >= cost) {
      tank.addScore(-cost);
      this.normal = false;
    }
  }

  setFire(game, tank) {
    if (tank.turret[0] > 0 && tank.turret[0] < Board.WIDTH) {
      this.x = tank.turret[0];
      this.y = tank.turret[1];

      this.angle = 270 + tank.turretAngle;
      this.power = tank.power;

      this.init = this.power * 0.08 + 1; // initial velocity, range ~1-9px
      this.velX = this.init * cos(radians(this.angle));
      this.velY = -this.init * sin(radians(this.angle));
    }
  }

  tick(game, tank) {
    if (this.x === -50 && this.y === -50) {
      this.velX = 0;
      this.velY = 0;
      return;
    }

    const terrainX = clamp(Math.floor(this.x), 0, game.terrainPosition.length - 1);

    if (this.y >= game.terrainPosition[terrainX]) {
      // hit terrain
      this.velX = 0;
      this.velY = 0;

      if (!this.normal) {
        this.explosion.setExplosionForXtra(this);
      } else {
        this.explosion.setExplosionForProjectile(this);
      }

      this.explosion.calcDamage(game, tank);
      this.explosion.updateTerrain(game);

      this.x = -50;
      this.y = -50;
      this.normal = true;
    } else if (this.x <= 5 || this.y <= 5 || this.x >= Board.WIDTH - 5 || this.y >= Board.HEIGHT - 5) {
      // out of screen
      this.x = -50;
      this.y = -50;
    } else {
      this.x += this.velX + (game.wind * 0.03) / FPS; // wind: w*0.03 px/sec
      this.y -= this.velY;
      this.velY -= 3.6 / FPS; // gravity: 3.6 px/sec^2
    }
  }
}

module.exports = { Projectile };
