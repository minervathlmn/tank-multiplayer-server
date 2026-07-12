// rooms/schema/TankRoomState.js

// Defines the data that Colyseus automatically syncs to every connected
// client whenever it changes. Keep this small — it's for lobby/turn state,
// NOT for per-frame physics (that stays local to each client's game logic).

const { Schema, MapSchema, type } = require("@colyseus/schema");

class Player extends Schema {
  constructor() {
    super();
    this.nickname = "";
    this.color = "";       // "red" | "blue" | "green" | "yellow" — matches your tank sprites
    this.isOwner = false;
    this.ready = false;
    this.connected = true;
  }
}
type("string")(Player.prototype, "nickname");
type("string")(Player.prototype, "color");
type("boolean")(Player.prototype, "isOwner");
type("boolean")(Player.prototype, "ready");
type("boolean")(Player.prototype, "connected");

class TankRoomState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
    this.started = false;
    this.currentTurnSessionId = "";
    this.ownerNickname = "";
    this.isPrivate = false;
    this.code = "";        // 4-digit join code, only meaningful when isPrivate is true
  }
}
type({ map: Player })(TankRoomState.prototype, "players");
type("boolean")(TankRoomState.prototype, "started");
type("string")(TankRoomState.prototype, "currentTurnSessionId");
type("string")(TankRoomState.prototype, "ownerNickname");
type("boolean")(TankRoomState.prototype, "isPrivate");
type("string")(TankRoomState.prototype, "code");

module.exports = { Player, TankRoomState };
