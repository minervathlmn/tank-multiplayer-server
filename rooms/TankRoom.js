// rooms/TankRoom.js
//
// One instance of this = one lobby/game. The server is NOT a physics
// simulator — it only tracks whose turn it is and relays that player's
// input to everyone (lockstep networking). Every client runs the same
// deterministic GameLogic/Tank code on the same relayed input, seeded
// with the same wind seed, so all four screens converge on their own.

const { Room } = require("colyseus");
const { TankRoomState, Player } = require("./schema/TankRoomState");

const COLORS = ["red", "blue", "green", "yellow"];
const LETTERS = ["A", "B", "C", "D"];

// Turn-gated actions: only the current turn-holder's client may send
// these, and they get relayed verbatim to every connected client
// (including the sender) so everyone runs the identical Tank method.
const TURN_ACTIONS = new Set([
  "rotateLeft", "rotateRight", "moveLeft", "moveRight",
  "morePower", "lessPower", "stopAdjustment",
  "fire", "repair", "addFuel", "addParachute", "xtra",
]);

function generateCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

class TankRoom extends Room {
  maxClients = 4;

  onCreate(options) {
    this.setState(new TankRoomState());

    const isPrivate = !!options.isPrivate;
    const ownerNickname = (options.nickname || "Player").slice(0, 16);
    const code = isPrivate ? generateCode() : "";

    this.state.isPrivate = isPrivate;
    this.state.code = code;
    this.state.ownerNickname = ownerNickname;
    this.reservedCode = code;

    // Fixed at "start" time — index 0 is always the owner ("player A" /
    // red), regardless of who leaves later. letterOrder mirrors the
    // alphabetical player-id order GameLogic.generateLevel() always
    // produces (see the sort in that file).
    this.sessionIds = [];
    this.letterOrder = [];

    this.setMetadata({ isPrivate, code, ownerNickname, playerCount: 0 });

    // --- lobby message handlers ---------------------------------------

    this.onMessage("ready", (client, ready) => {
      const player = this.state.players.get(client.sessionId);
      if (player) player.ready = !!ready;
    });

    this.onMessage("setVisibility", (client, payload) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.isOwner) return;
      if (this.state.started) return;

      const wantPrivate = !!payload?.isPrivate;
      this.state.isPrivate = wantPrivate;
      if (wantPrivate) {
        if (!this.reservedCode) this.reservedCode = generateCode();
        this.state.code = this.reservedCode;
      } else {
        this.state.code = "";
      }

      this.setMetadata({ ...this.metadata, isPrivate: wantPrivate, code: this.state.code });
    });

    this.onMessage("closeLobby", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.isOwner) return;

      this.broadcast("lobbyClosed");
      this.disconnect();
    });

    this.onMessage("kickPlayer", (client, payload) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.isOwner) return;

      const targetSessionId = payload?.sessionId;
      if (!targetSessionId || targetSessionId === client.sessionId) return;

      const targetClient = this.clients.find((c) => c.sessionId === targetSessionId);
      if (!targetClient) return;

      targetClient.send("kicked");
      targetClient.leave();
    });

    // Owner presses "Start". Locks in turn order (join order) and a
    // shared wind seed, then broadcasts both to every client.
    this.onMessage("start", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.isOwner) return;
      if (this.state.started) return;

      const allReady = [...this.state.players.values()].every((p) => p.ready);
      if (!allReady || this.state.players.size < 2) return;

      this.state.started = true;

      this.sessionIds = [...this.state.players.keys()]; // owner first, forever
      this.letterOrder = LETTERS.slice(0, this.sessionIds.length);
      this.state.currentTurnSessionId = this.sessionIds[0];

      // Server-authoritative elimination tracking. Clients report deaths
      // via "eliminated"; this array (not any client's local state) is
      // what turn advancement is computed from, so a lagging/desynced
      // client's stale view of who's alive can never corrupt turn order.
      this.remainingSessionIds = [...this.sessionIds];
      this.turnIndex = 0;

      const seed = Math.floor(Math.random() * 2 ** 31);

      this.broadcast("gameStart", {
        turnOrder: this.sessionIds,
        seed,
      });
    });

    // --- in-game message handlers ---------------------------------------

    // Any connected client reports a tank death the moment it sees one
    // locally (health <= 0 during its own tick). First report wins;
    // duplicates/late reports from other clients are ignored. This is
    // what remainingSessionIds is built from — never any single client's
    // "nextLetter" guess — so a client that's briefly desynced (e.g. a
    // throttled background tab) can't corrupt turn order for everyone.
    this.onMessage("eliminated", (client, payload) => {
      if (!this.state.started) return;

      const idx = this.letterOrder.indexOf(payload?.letter);
      if (idx === -1) return;

      const sessionId = this.sessionIds[idx];
      const pos = this.remainingSessionIds.indexOf(sessionId);
      if (pos === -1) return; // already removed / duplicate report

      this.remainingSessionIds.splice(pos, 1);
      this.broadcast("eliminated", { letter: payload.letter });
    });

    // Generic relay for any turn-gated input. The server never touches
    // tank state itself — it just checks whose turn it is, then echoes
    // the action to every client so they all apply it identically.
    this.onMessage("action", (client, payload) => {
      if (!this.state.started) return;
      if (client.sessionId !== this.state.currentTurnSessionId) return;

      const type = payload?.type;
      if (!TURN_ACTIONS.has(type)) return;

      this.broadcast("action", { type });

      if (type === "fire") {
        // Turn advancement is computed server-side from remainingSessionIds
        // (built purely from confirmed "eliminated" reports), not from any
        // client-supplied "nextLetter" — that value used to be trusted
        // directly, which let a desynced client hand the turn to the
        // wrong session and cascade the turn order for the rest of the game.
        if (this.remainingSessionIds.length > 1) {
          let guard = 0;
          do {
            this.turnIndex = (this.turnIndex + 1) % this.sessionIds.length;
            guard++;
          } while (
            !this.remainingSessionIds.includes(this.sessionIds[this.turnIndex]) &&
            guard <= this.sessionIds.length
          );
          this.state.currentTurnSessionId = this.sessionIds[this.turnIndex];
        }
      }
    });

    // Not turn-gated — any connected player can trigger a restart once
    // the level/game is over (mirrors the local 'R'-to-restart key).
    this.onMessage("restart", (client) => {
      if (!this.state.started) return;
      this.broadcast("restart");
    });
  }

  onJoin(client, options) {
    if (this.state.isPrivate && options.code !== this.state.code) {
      throw new Error("This lobby is private. Ask the host for the code.");
    }
    const player = new Player();
    player.nickname = (options.nickname || "Player").slice(0, 16);
    player.color = COLORS[this.state.players.size] || "gray";
    player.isOwner = this.state.players.size === 0;
    player.ready = true;
    player.connected = true;

    this.state.players.set(client.sessionId, player);

    this.setMetadata({ ...this.metadata, playerCount: this.state.players.size });
  }

  // onLeave(client) {
  //   const player = this.state.players.get(client.sessionId);
  //   if (!player) return;

  //   this.state.players.delete(client.sessionId);

  //   if (player.isOwner) {
  //     const nextSessionId = [...this.state.players.keys()][0];
  //     if (nextSessionId) {
  //       this.state.players.get(nextSessionId).isOwner = true;
  //       this.state.ownerNickname = this.state.players.get(nextSessionId).nickname;
  //     }
  //   }

  //   // Emergency fallback only (mid-game disconnect): simple round robin
  //   // over whoever's still connected. Turn-holder's own client normally
  //   // drives currentTurnSessionId via the "fire" nextLetter mapping above.
  //   if (this.state.started && this.state.currentTurnSessionId === client.sessionId) {
  //     const remaining = [...this.state.players.keys()];
  //     if (remaining.length) this.state.currentTurnSessionId = remaining[0];
  //   }

  //   this.setMetadata({ ...this.metadata, playerCount: this.state.players.size });

  //   if (this.state.players.size === 0) {
  //     this.disconnect();
  //   }
  // }

  async onLeave(client, consented) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    // Kicked players / explicit leaves close with a normal code -> consented
    // is true, so remove them immediately, no reconnection grace period.
    if (consented) {
      this.removePlayer(client);
      return;
    }

    player.connected = false;
    try {
      // Covers the Start -> game page navigation, which always drops the
      // socket for a moment, plus genuine network blips. 15s grace period.
      await this.allowReconnection(client, 15);
      player.connected = true;
    } catch (e) {
      // Didn't come back in time - actually gone.
      this.removePlayer(client);
    }
  }

  removePlayer(client) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    this.state.players.delete(client.sessionId);

    if (player.isOwner) {
      const nextSessionId = [...this.state.players.keys()][0];
      if (nextSessionId) {
        this.state.players.get(nextSessionId).isOwner = true;
        this.state.ownerNickname = this.state.players.get(nextSessionId).nickname;
      }
    }

    // Keep the elimination-tracking array in sync so a departed player
    // can never get stuck counted as "still alive" and jam the
    // turn-skip loop in the "fire" handler above.
    if (this.remainingSessionIds) {
      const rIdx = this.remainingSessionIds.indexOf(client.sessionId);
      if (rIdx !== -1) this.remainingSessionIds.splice(rIdx, 1);
    }

    if (this.state.started && this.state.currentTurnSessionId === client.sessionId) {
      const remaining = [...this.state.players.keys()];
      if (remaining.length) this.state.currentTurnSessionId = remaining[0];
    }

    this.setMetadata({ ...this.metadata, playerCount: this.state.players.size });

    if (this.state.players.size === 0) {
      this.disconnect();
    }
  }
}

module.exports = { TankRoom };