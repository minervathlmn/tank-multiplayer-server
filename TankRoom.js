// rooms/TankRoom.js
// One instance of this = one lobby/game (matches your "Create Lobby" screen).
// It does NOT run tank physics — it just relays turn actions and keeps
// everyone's lobby state in sync. Each client still runs your existing
// Tank.js / GameLogic.js locally and trusts the relayed action to replay it.

const { Room } = require("colyseus");
const { TankRoomState, Player } = require("./schema/TankRoomState");

const COLORS = ["red", "blue", "green", "yellow"];

class TankRoom extends Room {
  maxClients = 4;

  // Called once when the room is first created (by "Create Lobby" or
  // by joinOrCreate() during a "Quick Join").
  onCreate(options) {
    this.setState(new TankRoomState());

    const isPrivate = !!options.isPrivate;
    const ownerNickname = (options.nickname || "Player").slice(0, 16);

    this.setMetadata({
      isPrivate,
      ownerNickname,
      playerCount: 0,
    });

    // --- message handlers -------------------------------------------

    // A player toggles "ready" in the lobby.
    this.onMessage("ready", (client, ready) => {
      const player = this.state.players.get(client.sessionId);
      if (player) player.ready = !!ready;
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
    const player = new Player();
    player.nickname = (options.nickname || "Player").slice(0, 16);
    player.color = COLORS[this.state.players.size] || "gray";
    player.isOwner = this.state.players.size === 0; // first joiner owns the lobby
    player.ready = false;
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
