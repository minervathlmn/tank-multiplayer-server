// rooms/schema/TankState.js
//
// Synced mirror of one Tank's networked fields. Depends only on @colyseus/schema.

const { Schema, type } = require("@colyseus/schema");

/**
 * Synced mirror of one Tank's networked fields.
 *
 * This is NOT where physics runs — the plain-JS Tank class (ported from
 * Tank.java) still owns simulation via tick(); after each server tick,
 * TankRoom copies the subset below onto the matching TankState so
 * Colyseus can diff + push it to clients. Internal-only fields (velX/velY,
 * flags, falling helpers, the Projectile/Explosion sub-objects) deliberately
 * stay off the network.
 *
 * @property {string} letter - 'A'..'D', matches GameLogic.playerIDs / TurnManager.letterOrder.
 * @property {string} nickname - Copied once from Player.nickname at "start"; denormalized here so
 *   HUD/turn-banner code only needs this one object.
 * @property {number} x - World x-position in pixels.
 * @property {number} y - World y-position in pixels.
 * @property {number} health - Remaining health, 0-100.
 * @property {number} fuel - Remaining fuel.
 * @property {number} power - Current shot power setting.
 * @property {number} score - Running score/kill count for this tank.
 * @property {number} parachute - Number of parachutes currently held.
 * @property {number} turretAngle - Turret angle in degrees.
 * @property {boolean} falling - Whether the tank is currently falling (terrain collapsed beneath it).
 * @property {boolean} alive - False once selfDestruct() has run for this tank.
 * @property {boolean} isBot - True for AI-filled seats — see TankRoom's Bot wiring.
 * @property {number} colourR - Red channel, 0-255. Matches Tank.colour[0].
 * @property {number} colourG - Green channel, 0-255. Matches Tank.colour[1].
 * @property {number} colourB - Blue channel, 0-255. Matches Tank.colour[2].
 * @property {string} colourName - e.g. "Red" — looked up from config.json's player_colours by the
 *   actual RGB synced above, not re-resolved independently, so it can't drift out of sync with colourR/G/B.
 */
class TankState extends Schema {
  constructor() {
    super();

    // --- Identity ---------------------------------------------------------
    this.letter = "";     // 'A'..'D' — matches GameLogic.playerIDs / TurnManager.letterOrder
    this.nickname = "";   // copied once from Player.nickname at "start" — same value, just denormalized
                           // onto TankState so HUD/turn-banner code only needs this one object

    // --- Position -----------------------------------------------------------
    this.x = 0;
    this.y = 0;

    // --- Combat stats ---------------------------------------------------------
    this.health = 100;
    this.fuel = 250;
    this.power = 50;
    this.score = 0;
    this.parachute = 0;

    // --- Turret / motion state ------------------------------------------------
    this.turretAngle = 0;

    this.falling = false;
    this.alive = true;    // false once selfDestruct() has run for this tank
    this.isBot = false;   // true for AI-filled seats — see TankRoom's Bot wiring

    // --- Colour -----------------------------------------------------------------
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
// Colyseus schema types, registered via the functional type() API rather
// than @type decorators (avoids a decorator-transform dependency). Order
// mirrors the field declarations above field-for-field — keep it that way
// if fields are added/reordered, so the two lists stay easy to diff by eye.
type("string")(TankState.prototype, "letter");
type("string")(TankState.prototype, "nickname");
type("int16")(TankState.prototype, "x");
type("int16")(TankState.prototype, "y");
type("uint8")(TankState.prototype, "health");
type("uint16")(TankState.prototype, "fuel");
type("uint8")(TankState.prototype, "power");
type("uint32")(TankState.prototype, "score");
type("uint8")(TankState.prototype, "parachute");
type("int8")(TankState.prototype, "turretAngle");
type("boolean")(TankState.prototype, "falling");
type("boolean")(TankState.prototype, "alive");
type("boolean")(TankState.prototype, "isBot");
type("uint8")(TankState.prototype, "colourR");
type("uint8")(TankState.prototype, "colourG");
type("uint8")(TankState.prototype, "colourB");
type("string")(TankState.prototype, "colourName");

module.exports = { TankState };