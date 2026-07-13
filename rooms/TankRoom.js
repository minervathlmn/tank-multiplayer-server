// rooms/TankRoom.js

// One instance of this = one lobby/game (matches your "Create Lobby" screen).
// It does NOT run tank physics — it just relays turn actions and keeps
// everyone's lobby state in sync. Each client still runs your existing
// Tank.js / GameLogic.js locally and trusts the relayed action to replay it.

const { Room } = require("colyseus");
const { TankRoomState, Player } = require("./schema/TankRoomState");

const COLORS = ["red", "blue", "green", "yellow"];

// Generates a random 4-digit code as a string, e.g. "4213", "0067".
// Kept as a string (not a number) so leading zeros display correctly.
function generateCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

class TankRoom extends Room {
  maxClients = 4;

  // Called once when the room is first created (by "Create Lobby" or
  // by joinOrCreate() during a "Quick Join").
  onCreate(options) {
    this.setState(new TankRoomState());

    const isPrivate = !!options.isPrivate;
    const ownerNickname = (options.nickname || "Player").slice(0, 16);
    const code = isPrivate ? generateCode() : "";

    this.state.isPrivate = isPrivate;
    this.state.code = code;
    this.state.ownerNickname = ownerNickname;

    // Not part of the schema (never synced) — just remembers the code
    // across public/private toggles so switching public -> private ->
    // public -> private again reuses the same code instead of minting a
    // new one each time. state.code itself still gets blanked out while
    // public, since that's what gates join-by-code and the code display.
    this.reservedCode = code;

    this.setMetadata({
      isPrivate,
      code,
      ownerNickname,
      playerCount: 0,
    });

    // --- message handlers -------------------------------------------

    // A player toggles "ready" in the lobby.
    this.onMessage("ready", (client, ready) => {
      const player = this.state.players.get(client.sessionId);
      if (player) player.ready = !!ready;
    });

    // Owner toggles the lobby between public and private.
    // Switching to private generates a fresh code; switching to public
    // clears it. Both state (for in-room display) and metadata (so
    // getAvailableRooms/quick-join see the change) are updated together.
    this.onMessage("setVisibility", (client, payload) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.isOwner) return;
      if (this.state.started) return;

      const wantPrivate = !!payload?.isPrivate;
      this.state.isPrivate = wantPrivate;
      // Reuse the reserved code across public -> private -> public ->
      // private toggles; only mint a new one the first time this lobby
      // ever goes private.
      if (wantPrivate) {
        if (!this.reservedCode) this.reservedCode = generateCode();
        this.state.code = this.reservedCode;
      } else {
        this.state.code = "";
      }

      this.setMetadata({
        ...this.metadata,
        isPrivate: wantPrivate,
        code: this.state.code,
      });
    });

    // Owner closes the lobby entirely — kicks everyone, not just self.
    this.onMessage("closeLobby", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.isOwner) return;

      this.broadcast("lobbyClosed");
      this.disconnect();
    });

    // Owner removes a single player. We deliberately don't touch
    // state.players here ourselves — calling target.leave() triggers
    // this room's own onLeave(), which already handles removal, owner
    // handoff, turn-skipping, and metadata updates in one place.
    this.onMessage("kickPlayer", (client, payload) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.isOwner) return;

      const targetSessionId = payload?.sessionId;
      if (!targetSessionId || targetSessionId === client.sessionId) return;

      const targetClient = this.clients.find(
        (c) => c.sessionId === targetSessionId
      );
      if (!targetClient) return;

      targetClient.send("kicked");
      targetClient.leave();
    });

    // Owner presses "Start". Only allowed once everyone is ready.
    this.onMessage("start", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.isOwner) return; // only the owner can start
      if (this.state.started) return;

      const allReady = [...this.state.players.values()].every((p) => p.ready);
      if (!allReady || this.state.players.size < 2) return;

      this.state.started = true;
      const firstSessionId = [...this.state.players.keys()][0];
      this.state.currentTurnSessionId = firstSessionId;

      this.broadcast("gameStart", {
        turnOrder: [...this.state.players.keys()],
      });
    });

    // A player fires. We don't simulate physics here — we just verify
    // whose turn it is, then relay the shot to everyone (including the
    // sender, for consistency) and advance the turn.
    this.onMessage("fire", (client, action) => {
      if (!this.state.started) return;
      if (client.sessionId !== this.state.currentTurnSessionId) return;

      // action expected shape: { angle: number, power: number }
      this.broadcast("shotFired", {
        sessionId: client.sessionId,
        angle: action?.angle,
        power: action?.power,
      });

      this.advanceTurn();
    });
  }

  onJoin(client, options) {
    // Authoritative privacy check. filterBy(["isPrivate"]) only reflects
    // the value passed at room CREATION time — if the owner later toggles
    // the lobby private via setVisibility, that filterBy cache goes stale
    // and Quick Join's joinOrCreate() can still match this room. This is
    // the actual gate that keeps a private lobby private, regardless of
    // whether the client arrived via Quick Join, Join by Code, or the
    // public room list.
    if (this.state.isPrivate && options.code !== this.state.code) {
      // Throwing here rejects the client's join()/joinOrCreate() promise
      // with this message and releases the seat — nothing gets added to
      // state.players.
      throw new Error("This lobby is private. Ask the host for the code.");
    }
    const player = new Player();
    player.nickname = (options.nickname || "Player").slice(0, 16);
    player.color = COLORS[this.state.players.size] || "gray";
    player.isOwner = this.state.players.size === 0; // first joiner owns the lobby
    // No "ready" step in the current UI — everyone who joins is ready to go.
    player.ready = true;
    player.connected = true;

    this.state.players.set(client.sessionId, player);

    this.setMetadata({
      ...this.metadata,
      playerCount: this.state.players.size,
    });
  }

  onLeave(client) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    this.state.players.delete(client.sessionId);

    // If the owner left, hand ownership to whoever's next (if anyone).
    if (player.isOwner) {
      const nextSessionId = [...this.state.players.keys()][0];
      if (nextSessionId) {
        this.state.players.get(nextSessionId).isOwner = true;
        this.state.ownerNickname = this.state.players.get(nextSessionId).nickname;
      }
    }

    // If it was this player's turn, skip to the next one.
    if (this.state.currentTurnSessionId === client.sessionId) {
      this.advanceTurn();
    }

    this.setMetadata({
      ...this.metadata,
      playerCount: this.state.players.size,
    });

    // Close empty lobbies so they don't linger in the public list.
    if (this.state.players.size === 0) {
      this.disconnect();
    }
  }

  advanceTurn() {
    const sessionIds = [...this.state.players.keys()];
    if (sessionIds.length === 0) return;

    const currentIndex = sessionIds.indexOf(this.state.currentTurnSessionId);
    const nextIndex = (currentIndex + 1) % sessionIds.length;
    this.state.currentTurnSessionId = sessionIds[nextIndex];
  }
}

module.exports = { TankRoom };