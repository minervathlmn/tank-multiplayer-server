// rooms/schema/TankRoomState.js

// Defines the data that Colyseus automatically syncs to every connected
// client whenever it changes. Lobby fields (players/started/etc.) are
// unchanged from before. New below: in-game state, now server-authoritative
// instead of relayed for clients to simulate themselves.

const { Schema, MapSchema, ArraySchema, type } = require("@colyseus/schema");
const { TankState } = require("./TankState");

class Player extends Schema {
  constructor() {
    super();
    this.nickname = "";
    this.color = "";       // "r,g,b" string, resolved from config.player_colours at join time
    this.letter = "";      // board letter ('A'-'D'), fixed at join — same value TankState.letter will use
    this.isOwner = false;
    this.ready = false;
    this.connected = true;
  }
}
type("string")(Player.prototype, "nickname");
type("string")(Player.prototype, "color");
type("string")(Player.prototype, "letter");
type("boolean")(Player.prototype, "isOwner");
type("boolean")(Player.prototype, "ready");
type("boolean")(Player.prototype, "connected");

class TankRoomState extends Schema {
  constructor() {
    super();

    // --- lobby (unchanged) ---
    this.players = new MapSchema();
    this.started = false;
    this.currentTurnSessionId = "";
    this.ownerNickname = "";
    this.isPrivate = false;
    this.code = "";        // 4-digit join code, only meaningful when isPrivate is true

    // --- in-game, server-authoritative ---
    this.tanks = new MapSchema();          // sessionId -> TankState
    this.terrainPosition = new ArraySchema(); // one height value per pixel column (Board.terrainPosition)
    this.trees = new ArraySchema();        // tree pixel x-positions, fixed per level
    this.wind = 0;
    this.currentLevel = 1;
    this.gameEnded = false;

    // level theming — cosmetic on the client, but which level is active
    // (and therefore which assets apply) is a server decision
    this.backgroundImageName = "basic.png";
    this.treeImageName = "tree1.png";
    this.terrainColourR = 120;
    this.terrainColourG = 171;
    this.terrainColourB = 0;
  }
}
type({ map: Player })(TankRoomState.prototype, "players");
type("boolean")(TankRoomState.prototype, "started");
type("string")(TankRoomState.prototype, "currentTurnSessionId");
type("string")(TankRoomState.prototype, "ownerNickname");
type("boolean")(TankRoomState.prototype, "isPrivate");
type("string")(TankRoomState.prototype, "code");

type({ map: TankState })(TankRoomState.prototype, "tanks");
type(["number"])(TankRoomState.prototype, "terrainPosition");
type(["number"])(TankRoomState.prototype, "trees");
type("number")(TankRoomState.prototype, "wind");
type("number")(TankRoomState.prototype, "currentLevel");
type("boolean")(TankRoomState.prototype, "gameEnded");
type("string")(TankRoomState.prototype, "backgroundImageName");
type("string")(TankRoomState.prototype, "treeImageName");
type("uint8")(TankRoomState.prototype, "terrainColourR");
type("uint8")(TankRoomState.prototype, "terrainColourG");
type("uint8")(TankRoomState.prototype, "terrainColourB");

module.exports = { Player, TankRoomState };
