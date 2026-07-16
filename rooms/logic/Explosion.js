// rooms/logic/Explosion.js
// Port of client Explosion.js. calcDamage()/updateTerrain() are the real
// game logic (server-authoritative now) and are unchanged. tick()/draw()
// are dropped: they only drive the fading red/orange/yellow blast
// *animation* (count/redSize/etc.), which nothing in Tank.js or
// Projectile.js's tick() control flow ever reads — neither selfDestruct()
// nor Projectile.tick() calls explosion.tick(), they call calcDamage()/
// updateTerrain() directly and immediately. Client keeps its own
// Explosion class for the visual animation, triggered off the server's
// broadcast of where/how big the blast was.

const { Board } = require('./Board');

class Explosion {
  static ANIMATION_TICKS = 6;

  constructor() {
    this.x = -50;
    this.y = -50;
    this.radius = 30;
  }

  setExplosionForProjectile(projectile) {
    this.x = projectile.x;
    this.y = projectile.y;
    this.radius = 30; // reset to default - previously could stay at 60/15 from a prior shot
  }

  setExplosionForTank(tank, health) {
    this.x = tank.x;
    this.y = tank.y - 2;

    if (health === 0) {
      this.radius = 15; // self-destruct: smaller blast
    }
  }

  // power-up: doubled blast radius
  setExplosionForXtra(projectile) {
    this.x = projectile.x;
    this.y = projectile.y;
    this.radius = 60;
  }

  calcDamage(game, playerTank) {
    for (const id of [...game.remainingTanks]) {
      const tank = game.players.get(id);
      if (!tank) continue;

      const minX = tank.x - 10;
      const maxX = tank.x + 10;
      const minY = tank.y - 6;
      const maxY = tank.y + 2;

      const closestX = Math.max(minX, Math.min(this.x, maxX));
      const closestY = Math.max(minY, Math.min(this.y, maxY));
      const distance = Math.sqrt((closestX - this.x) ** 2 + (closestY - this.y) ** 2);

      if (distance <= this.radius || (this.x > minX && this.x < maxX && this.y > minY && this.y < maxY)) {
        game.damagedTanks.add(tank);

        const damagePercentage = 1 - distance / this.radius;
        const maxDamage = 60;
        const damage = Math.floor(damagePercentage * maxDamage);

        if (tank !== playerTank) {
          if (tank.health - damage <= 0) {
            playerTank.addScore(tank.health);
          } else {
            playerTank.addScore(damage);
          }
        }

        tank.setHealth(-damage);
        if (tank.health < tank.power) {
          tank.setPower(tank.health);
        }
      }
    }
  }

  updateTerrain(game) {
    const fromX = Math.max(0, Math.floor(this.x - this.radius));
    const toX = Math.min(Board.WIDTH, Math.floor(this.x + this.radius));

    for (let i = fromX; i <= toX; i++) {
      const currY = Math.floor(Math.sqrt(this.radius ** 2 - (i - this.x) ** 2) + this.y);
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
