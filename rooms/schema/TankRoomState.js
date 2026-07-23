// rooms/schema/TankRoomState.js
//
// Defines the data that Colyseus automatically syncs to every connected
// client whenever it changes. Lobby fields (players/started/etc.) are
// unchanged from before. New below: in-game state, now server-authoritative
// instead of relayed for clients to simulate themselves. Depends on
// @colyseus/schema and TankState.

const { Schema, MapSchema, ArraySchema, type } = require("@colyseus/schema");
const { TankState } = require("./TankState");

/**
 * Synced lobby-facing record for one connected client, keyed by sessionId
 * in TankRoomState.players. Exists for the whole time a client is
 * connected, from lobby through end-of-match — unlike TankState, which
 * only exists once the game has actually started (see TankRoom.onJoin()
 * for why letter/color are deliberately deferred rather than set here).
 *
 * Bots are also represented as Player entries here (added via the
 * "addBot" message, host-only, lobby-only) so the lobby's player list is
 * a single unified list of every occupied seat — human or AI — rather
 * than a separate parallel concept. A bot's key in `players` is not a
 * real Colyseus sessionId; see botSeatId() in TankRoom.js.
 *
 * @property {string} nickname - Display name chosen at join time (humans)
 *   or "Bot" (bots, set by "addBot" — difficulty is tracked separately, see `difficulty` below).
 * @property {string} difficulty - Bot-only: 'easy'|'medium'|'hard'|'expert', set from the
 *   room's default at "addBot" time and host-adjustable per-bot afterward via
 *   "setBotDifficulty". Empty string for human seats.
 * @property {string} color - "r,g,b" string, resolved from config.player_colours
 *   once the game starts. NOTE: spelled "color" (American) here, unlike
 *   TankState's "colour" fields (colourR/G/B/colourName) and everything else
 *   in rooms/logic/ — a pre-existing inconsistency, not touched in this pass
 *   since it's a networked field name a client may already depend on.
 * @property {string} letter - Board letter ('A'-'D'), fixed once the game starts —
 *   same value TankState.letter will use for this same seat.
 * @property {boolean} isOwner - Whether this client can start the match / configure the lobby.
 *   Always false for a bot seat — bots can't own a lobby.
 * @property {boolean} ready - Whether this seat is marked ready to start. Bots are
 *   always ready (set true at "addBot" time) so they never block the host from starting.
 * @property {boolean} connected - False while a client is disconnected but still
 *   holding their seat (see TankRoom's reconnection handling). Always true for a bot seat.
 * @property {boolean} isBot - Whether this seat is AI-controlled rather than a real client.
 */
class Player extends Schema {
  constructor() {
    super();
    this.nickname = "";
    this.color = "";       // "r,g,b" string, resolved from config.player_colours at join time
    this.letter = "";      // board letter ('A'-'D'), fixed at join — same value TankState.letter will use
    this.isOwner = false;
    this.ready = false;
    this.connected = true;
    this.isBot = false;    // true for seats added via "addBot" — see class doc above
    this.difficulty = "";  // bot-only: 'easy'|'medium'|'hard'|'expert' — see class doc above
  }
}
// Colyseus schema types, registered via the functional type() API rather
// than @type decorators (see TankState.js for why). Order mirrors each
// class's field declarations above field-for-field — keep it that way if
// fields are added/reordered, so the two lists stay easy to diff by eye.
type("string")(Player.prototype, "nickname");
type("string")(Player.prototype, "color");
type("string")(Player.prototype, "letter");
type("boolean")(Player.prototype, "isOwner");
type("boolean")(Player.prototype, "ready");
type("boolean")(Player.prototype, "connected");
type("boolean")(Player.prototype, "isBot");
type("string")(Player.prototype, "difficulty");

/**
 * Root synced state for one TankRoom — everything Colyseus pushes to every
 * connected client whenever it changes. Split into two eras of the same
 * match: lobby fields (players/started/etc., present from the first join)
 * and in-game fields (tanks/terrainPosition/etc., populated once the match
 * starts and server-authoritative simulation takes over — see TankRoom.js
 * for where each half gets written).
 *
 * @property {MapSchema<Player>} players - Every connected client, keyed by sessionId.
 * @property {boolean} started - Whether the match has left the lobby and begun.
 * @property {string} currentTurnSessionId - sessionId of whichever client currently
 *   holds the turn — TankRoom's translation of GameLogic.currentPlayer (a board
 *   letter) into the session id clients actually key off.
 * @property {string} this.turnEndsAt - 
 * @property {string} ownerNickname - Nickname of the lobby owner, denormalized here
 *   so lobby UI doesn't need to cross-reference players by isOwner.
 * @property {boolean} isPrivate - Whether joining requires the matching `code`.
 * @property {string} code - 4-digit join code, only meaningful when isPrivate is true.
 * @property {MapSchema<TankState>} tanks - One TankState per in-game tank, keyed by sessionId.
 * @property {number[]} terrainPosition - One height value per pixel column for the
 *   current level (mirrors GameLogic.terrainPosition / Board.terrainPosition).
 * @property {number[]} trees - Tree pixel x-positions, fixed per level.
 * @property {number} wind - Current wind value driving projectile drift this turn.
 * @property {number} currentLevel - 1-indexed active level (matches GameLogic.currentLevel).
 * @property {boolean} gameEnded - Whether the match (all configured levels) is over.
 * @property {string} backgroundImageName - Cosmetic background asset for the current level.
 * @property {string} treeImageName - Cosmetic tree asset for the current level.
 * @property {number} terrainColourR - Terrain fill colour, red channel, 0-255.
 * @property {number} terrainColourG - Terrain fill colour, green channel, 0-255.
 * @property {number} terrainColourB - Terrain fill colour, blue channel, 0-255.
 */
class TankRoomState extends Schema {
  constructor() {
    super();

    // --- Lobby (unchanged) ------------------------------------------------
    this.players = new MapSchema();
    this.started = false;
    this.currentTurnSessionId = "";
    this.turnEndsAt = 0; // ms epoch (Date.now()-based); client computes remaining
                          // time locally as turnEndsAt - Date.now() each frame
    this.ownerNickname = "";
    this.isPrivate = false;
    this.code = "";        // 4-digit join code, only meaningful when isPrivate is true

    // --- In-game, server-authoritative -------------------------------------
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
type("number")(TankRoomState.prototype, "turnEndsAt");
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