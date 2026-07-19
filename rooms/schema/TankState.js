// rooms/schema/TankState.js

// Synced mirror of one Tank's networked fields. This is NOT where physics
// runs — the plain-JS Tank class (ported from Tank.java) still owns
// simulation via tick(); after each server tick, TankRoom copies the
// subset below onto the matching TankState so Colyseus can diff + push
// it to clients. Internal-only fields (velX/velY, flags, falling helpers,
// the Projectile/Explosion sub-objects) deliberately stay off the network.

const { Schema, type } = require("@colyseus/schema");

class TankState extends Schema {
  constructor() {
    super();

    this.letter = "";     // 'A'..'D' — matches GameLogic.playerIDs / TurnManager.letterOrder
    this.nickname = "";   // copied once from Player.nickname at "start" — same value, just denormalized
                           // onto TankState so HUD/turn-banner code only needs this one object
    this.x = 0;
    this.y = 0;

    this.health = 100;
    this.fuel = 250;
    this.power = 50;
    this.score = 0;
    this.parachute = 0;

    this.turretAngle = 0;

    this.falling = false;
    this.alive = true;    // false once selfDestruct() has run for this tank
    this.isBot = false;   // true for AI-filled seats — see TankRoom's Bot wiring

    // colour as three 0-255 components, matching Tank.colour ([r,g,b])
    this.colourR = 0;
    this.colourG = 0;
    this.colourB = 0;
    this.colourName = "";  // e.g. "Red" — looked up from config.json's
                            // player_colours by the actual RGB TankRoom
                            // synced above, not re-resolved independently,
                            // so it can't drift out of sync with colourR/G/B
  }
}
type("string")(TankState.prototype, "letter");
type("string")(TankState.prototype, "nickname");
type("number")(TankState.prototype, "x");
type("number")(TankState.prototype, "y");
type("number")(TankState.prototype, "health");
type("number")(TankState.prototype, "fuel");
type("number")(TankState.prototype, "power");
type("number")(TankState.prototype, "score");
type("number")(TankState.prototype, "parachute");
type("number")(TankState.prototype, "turretAngle");
type("boolean")(TankState.prototype, "falling");
type("boolean")(TankState.prototype, "alive");
type("boolean")(TankState.prototype, "isBot");
type("uint8")(TankState.prototype, "colourR");
type("uint8")(TankState.prototype, "colourG");
type("uint8")(TankState.prototype, "colourB");
type("string")(TankState.prototype, "colourName");

module.exports = { TankState };