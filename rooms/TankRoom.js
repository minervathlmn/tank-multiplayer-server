// rooms/TankRoom.js
//
// One instance of this = one lobby/game. Server-authoritative: GameLogic/
// Tank/Projectile/Explosion run for real here, on a fixed-rate simulation
// interval, and results are synced into TankRoomState/TankState each tick.
// Clients send only input intent ("rotateLeft", "fire", etc.) and render
// whatever the schema says — no gameplay decisions happen client-side.

const fs = require('fs');
const path = require('path');
const { Room } = require('colyseus');
const { ArraySchema } = require('@colyseus/schema');
const { TankRoomState, Player } = require('./schema/TankRoomState');
const { TankState } = require('./schema/TankState');
const { GameLogic } = require('./logic/GameLogic');
const { resolvePlayerColour, buildColourNameLookup } = require('./logic/colour');
const { Board } = require('./logic/Board');
const { radians, sin, cos } = require('./logic/mathUtils');
const { Explosion } = require('./logic/Explosion');

// Board letters assigned by join order, locked in once at "start" — room
// creator is always 'A', next joiner 'B', etc., based on join order at
// that moment (see the "start" handler and onJoin's comment for why).
// This assumes every level layout defines start positions for these exact
// letters; if a layout ever doesn't, "start" fails loudly (see below)
// rather than silently spawning a mismatched or missing tank.
const LETTERS = ["A", "B", "C", "D"];

const TURN_ACTIONS = new Set([
  "rotateLeft", "rotateRight", "moveLeft", "moveRight",
  "morePower", "lessPower", "stopAdjustment",
  "fire", "repair", "addFuel", "addParachute", "xtra",
]);

function generateCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// Kept short relative to the in-game grace (15s): a lobby refresh is a much
// faster round-trip than a game-page reconnect (no level assets/canvas to
// re-init) — this just needs to survive a normal reload (page teardown,
// new document parse, script re-init, reconnect handshake), not cover a
// real connection drop. Every second here is also a second the owner's
// room may sit locked out of the public list/new joins if it's the owner
// reconnecting, so err short rather than long.
const LOBBY_RECONNECT_GRACE_SECONDS = 4;

// How long to hold the previous round's synced state before broadcasting
// the next round's terrain/background, once a level switch happens
// mid-tick. The fatal shot's own flight doesn't need accounting for here:
// GameLogic.Projectile ticks once per real simulation frame (see
// setSimulationInterval below), so by the time a level switch is even
// detected, that flight has already taken exactly as long in wall-clock
// time as the client's own local replay of it (same physics, same FPS).
// What's NOT accounted for anywhere else is the explosion's own
// post-landing blast animation, which is purely visual/client-side — so
// derive its real duration from Explosion's actual tick-cycle length
// rather than guessing a number of ms.
const EXPLOSION_ANIMATION_MS = Math.ceil((Explosion.ANIMATION_TICKS / GameLogic.FPS) * 1000);

// Small, explicitly-separate safety margin — NOT part of the "real"
// duration above — to absorb the shotFired/tankExploded network hop and
// the odd dropped client frame. Safe to shrink/remove if it ever proves
// unnecessary; it's not standing in for any actual animation length.
const LEVEL_TRANSITION_SAFETY_MS = 150;

const LEVEL_TRANSITION_DELAY_MS = EXPLOSION_ANIMATION_MS + LEVEL_TRANSITION_SAFETY_MS;

function loadLevels() {
  const levelsDir = path.join(__dirname, '../levels');
  const config = JSON.parse(fs.readFileSync(path.join(levelsDir, 'config.json'), 'utf-8'));

  const levelLayouts = {};
  for (const level of config.levels) {
    const raw = fs.readFileSync(path.join(levelsDir, level.layout), 'utf-8');
    levelLayouts[level.layout] = raw.split('\n');
  }

  return { config, levelLayouts };
}

class TankRoom extends Room {
  maxClients = 4;

  onCreate(options) {
    this.setState(new TankRoomState());

    const { config, levelLayouts } = loadLevels();
    this.config = config;
    this.levelLayouts = levelLayouts;
    this.colourNames = buildColourNameLookup(config);

    this.game = null;             // GameLogic instance, created at "start"
    this.sessionToLetter = new Map(); // populated once, at "start" — see onJoin's comment
    this.letterToSession = new Map();
    this.noReconnectSessionIds = new Set(); // explicit kicks/leaves — onLeave skips reconnection grace for these

    // Set while we're deliberately holding back a level-switch sync so the
    // last shot's flight + explosion can finish animating on clients before
    // the terrain/background swap to the next round. See update()'s
    // currentLevel check for why this is needed.
    this.levelTransitionPending = false;
    this.levelTransitionTimeout = null;

    const isPrivate = !!options.isPrivate;
    const ownerNickname = (options.nickname || "Player").slice(0, 16);
    const code = isPrivate ? generateCode() : "";

    this.state.isPrivate = isPrivate;
    this.state.code = code;
    this.state.ownerNickname = ownerNickname;
    this.reservedCode = code;

    this.setMetadata({ isPrivate, code, ownerNickname, playerCount: 0 });

    // --- lobby message handlers (unchanged) -----------------------------

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

    this.onMessage("leaveLobby", (client) => {
      // Client is about to call room.leave() intentionally (Leave/Back
      // button) — this is the marker that tells onLeave to skip the
      // reconnection grace period, same idea as a kick.
      this.noReconnectSessionIds.add(client.sessionId);
    });

    this.onMessage("kickPlayer", (client, payload) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.isOwner) return;

      const targetSessionId = payload?.sessionId;
      if (!targetSessionId || targetSessionId === client.sessionId) return;

      const targetClient = this.clients.find((c) => c.sessionId === targetSessionId);
      if (!targetClient) return;

      this.noReconnectSessionIds.add(targetSessionId);
      targetClient.send("kicked");

      // Remove the player from state right now instead of waiting for the
      // socket to actually finish closing (targetClient.leave() only
      // *initiates* the close — onLeave fires whenever that round-trip
      // completes, which can be delayed on a slow connection, e.g. by the
      // kicked client's own blocking alert() holding up its event loop).
      // Without this, the owner's player list — and this room's
      // metadata.playerCount, which Quick Join filters on — stayed stale
      // for however long that took, sometimes looking like the lobby
      // still had 4 players when it didn't.
      this.removePlayer(targetClient);

      targetClient.leave();
    });

    // --- start ------------------------------------------------------------

    this.onMessage("start", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.isOwner) return;
      if (this.state.started) return;

      const allReady = [...this.state.players.values()].every((p) => p.ready);
      if (!allReady || this.state.players.size < 2) return;

      const sessionIds = [...this.state.players.keys()]; // owner first, forever
      const seed = Math.floor(Math.random() * 2 ** 31);

      // Letters are assigned here, fresh, from current join order — not
      // maintained incrementally through the lobby (see onJoin's comment).
      // Rebuilding both maps from scratch each time this handler runs is
      // deliberate: it's idempotent, so a failed start attempt below
      // (missing level start positions) just gets silently recomputed
      // identically — or differently, if someone left/joined — on the
      // next attempt, with no stale state to clean up either way.
      this.sessionToLetter.clear();
      this.letterToSession.clear();
      sessionIds.forEach((sessionId, i) => {
        const letter = LETTERS[i];
        this.sessionToLetter.set(sessionId, letter);
        this.letterToSession.set(letter, sessionId);

        const seatedPlayer = this.state.players.get(sessionId);
        seatedPlayer.letter = letter;
        seatedPlayer.color = resolvePlayerColour(this.config, letter).join(",");
      });

      const activeLetters = sessionIds.map((id) => this.sessionToLetter.get(id));

      this.game = new GameLogic(this.config, this.levelLayouts, seed, activeLetters);

      const missing = activeLetters.filter((letter) => !this.game.players.has(letter));
      if (missing.length > 0) {
        // Loud failure instead of a silent phantom/missing tank: the level
        // layout doesn't define a start position for one of the letters
        // this room actually needs.
        this.broadcast("startFailed", {
          reason: `Level is missing player start(s) for: ${missing.join(", ")}`,
        });
        this.game = null;
        return;
      }

      this.state.started = true;
      this.lock(); // remove from public listing — onJoin already rejects late joiners,
                    // but without this a started game still shows up in "Join Others"

      for (const sessionId of sessionIds) {
        const tankState = new TankState();
        tankState.letter = this.sessionToLetter.get(sessionId);
        tankState.nickname = this.state.players.get(sessionId)?.nickname || `Player ${tankState.letter}`;
        this.state.tanks.set(sessionId, tankState);
      }

      this.syncFullState();

      this.broadcast("gameStart", { seed });

      this.setSimulationInterval((deltaMs) => this.update(deltaMs / 1000), 1000 / GameLogic.FPS);
    });

    // --- in-game message handlers ------------------------------------------

    this.onMessage("action", (client, payload) => {
      if (!this.state.started || !this.game) return;
      if (client.sessionId !== this.state.currentTurnSessionId) return;

      const type = payload?.type;
      if (!TURN_ACTIONS.has(type)) return;

      const letter = this.sessionToLetter.get(client.sessionId);
      const tank = this.game.players.get(letter);
      if (!tank) return;

      if (type === "fire") {
        tank.stopAdjustment();
        const wasXtra = !tank.projectile.normal;
        tank.projectile.setFire(this.game, tank);

        // Cosmetic-only: lets clients replay the same simple trajectory
        // locally for the shell/explosion animation. The server has
        // already resolved the real outcome (damage, terrain) by the
        // time this arrives — this is purely so clients see something.
        this.broadcast("shotFired", {
          shooterSessionId: client.sessionId,
          startX: tank.projectile.x,
          startY: tank.projectile.y,
          angle: tank.projectile.angle,
          power: tank.projectile.power,
          wasXtra,
        });

        this.game.playerOrder(); // confirmed from sketch.js: turn passes immediately on fire

        // Sync the new turn holder right now rather than waiting for the
        // next simulation tick's update() to do it. Without this, a second
        // "action" message arriving before the next tick (e.g. a fast
        // double-tap of fire) would still pass the
        // `client.sessionId !== this.state.currentTurnSessionId` check
        // above against the stale, pre-turn-pass value — letting the same
        // client fire twice and call playerOrder() an extra time, which
        // (with 2 players) flips the turn forward and immediately back,
        // leaving currentPlayer/currentTurnSessionId desynced.
        this.state.currentTurnSessionId = this.letterToSession.get(this.game.currentPlayer) ?? "";
      } else if (type === "xtra") {
        tank.projectile.xtra(tank);
      } else {
        tank[type]();
      }
    });

    this.onMessage("restart", (client) => {
      if (!this.state.started || !this.game) return;

      if (this.levelTransitionTimeout) {
        this.levelTransitionTimeout.clear();
        this.levelTransitionTimeout = null;
      }
      this.levelTransitionPending = false;

      this.game.restartGame();
      this.syncFullState();
      this.broadcast("restart");
    });
  }

  // Copies everything from the plain-JS GameLogic/Tank simulation onto the
  // synced schema. Called at game start, on restart, and whenever a level
  // switch happens (board/tanks are rebuilt fresh by generateLevel()).
  syncFullState() {
    const game = this.game;

    this.state.wind = game.wind;
    this.state.currentLevel = game.currentLevel;
    this.state.gameEnded = game.gameEnded;
    this.state.backgroundImageName = game.backgroundImageName;
    this.state.treeImageName = game.treeImageName;
    [this.state.terrainColourR, this.state.terrainColourG, this.state.terrainColourB] = game.terrainColour;

    this.state.terrainPosition = new ArraySchema(...game.terrainPosition);
    this.state.trees = new ArraySchema(...game.trees);

    this.state.currentTurnSessionId = this.letterToSession.get(game.currentPlayer) ?? "";

    for (const [sessionId, letter] of this.sessionToLetter) {
      const tank = game.players.get(letter);
      const tankState = this.state.tanks.get(sessionId);
      if (!tank || !tankState) continue;
      this.syncTankState(tank, tankState, game);

      const player = this.state.players.get(sessionId);
      if (player) player.color = tank.colour.join(",");
    }
  }

  syncTankState(tank, tankState, game) {
    tankState.x = tank.x;
    tankState.y = tank.y;
    tankState.health = tank.health;
    tankState.fuel = tank.fuel;
    tankState.power = tank.power;
    tankState.score = tank.score;
    tankState.parachute = tank.parachute;
    tankState.turretAngle = tank.turretAngle;
    tankState.falling = tank.falling;
    tankState.alive = game.remainingTanks.includes(tank.player);
    [tankState.colourR, tankState.colourG, tankState.colourB] = tank.colour;
    tankState.colourName = this.colourNames[tank.colour.join(",")] || "Player";
  }

  update(dt) {
    if (!this.game || this.levelTransitionPending) return;
    const game = this.game;
    const levelBefore = game.currentLevel;

    // Only alive tanks tick — matches original drawTanks()'s iteration
    // over [...game.remainingTanks], not all game.playerIDs.
    for (const letter of [...game.remainingTanks]) {
      const tank = game.players.get(letter);
      if (!tank) continue;

      // Confirmed from sketch.js's drawTanks(): a tank whose terrain was
      // just carved out from under it (added to damagedTanks by
      // Explosion.updateTerrain()) starts falling; otherwise it stays
      // glued to the terrain height at its x position. This was never in
      // GameLogic/Tank/Explosion — it only lived in the client's render
      // loop, but it's real game logic (falling affects health), so it
      // moves server-side now.
      if (game.damagedTanks.has(tank)) {
        tank.fall();
      } else {
        tank.updatePosition(game);
      }

      tank.tick(game, dt);
      tank.projectile.tick(game, tank);

      // Detect a death that just happened this tick (selfDestruct() was
      // called somewhere inside tick()/projectile.tick()) and broadcast
      // it for the client's blast animation — reusing whatever x/y/radius
      // setExplosionForTank() already set on this tank's own explosion
      // object, rather than recomputing anything.
      if (tank.health <= 0 || !game.remainingTanks.includes(letter)) {
        const exp = tank.projectile.explosion;
        this.broadcast("tankExploded", { x: exp.x, y: exp.y, radius: exp.radius });
      }
    }

    // A level switch rebuilds board + all Tank instances inside GameLogic,
    // synchronously, as part of the tick above — by this point game.terrain/
    // game.players already belong to the NEXT round. But every client is
    // still mid-animation for the tankExploded broadcast sent above, and/or
    // still replaying the fatal shot's own flight locally (CosmeticProjectile
    // reads state.terrainPosition live every frame — see sketch.js's
    // drawShots()). Broadcasting the next round's terrain/background right
    // now would swap the ground out from under both mid-animation. Leave
    // state exactly as the previous, still-synced tick left it (last round's
    // terrain, tank positions/health) for a buffer, then flip everyone to
    // the next round all at once.
    if (game.currentLevel !== levelBefore) {
      this.levelTransitionPending = true;
      this.levelTransitionTimeout = this.clock.setTimeout(() => {
        this.levelTransitionPending = false;
        this.levelTransitionTimeout = null;
        this.syncFullState();
      }, LEVEL_TRANSITION_DELAY_MS);
      return;
    }

    for (const [sessionId, letter] of this.sessionToLetter) {
      const tank = game.players.get(letter);
      const tankState = this.state.tanks.get(sessionId);
      if (!tank || !tankState) continue;
      this.syncTankState(tank, tankState, game);
    }

    this.state.wind = game.wind;
    this.state.gameEnded = game.gameEnded;
    this.state.currentTurnSessionId = this.letterToSession.get(game.currentPlayer) ?? "";

    // Terrain only changes from an explosion — cheap to copy every tick
    // regardless (Colyseus only sends the actual diffed indices over the
    // wire), simpler and safer than trying to detect "did it change".
    this.state.terrainPosition = new ArraySchema(...game.terrainPosition);
  }

  onJoin(client, options) {
    if (this.state.started) {
      throw new Error("This game has already started.");
    }
    if (this.state.isPrivate && options.code !== this.state.code) {
      throw new Error("This lobby is private. Ask the host for the code.");
    }
    if (this.state.players.size >= LETTERS.length) {
      throw new Error("This lobby is full.");
    }

    // Letter (and the colour that comes with it) is deliberately NOT
    // assigned here. Nothing in the lobby UI ever reads Player.letter or
    // Player.color — the client only reads .letter off TankState, which
    // doesn't exist until the game starts. Assigning at join time meant a
    // freed letter (someone left) just sat there for whoever joined next
    // to claim, in LETTERS order — which could hand a rejoining player
    // their old letter back out of their new join position, or need a
    // full re-letter pass on every leave to stay contiguous. Deferring the
    // whole thing to "start" (see that handler) sidesteps all of it: by
    // then the room's final seat order is exactly this.state.players'
    // join order, computed fresh, once, with nothing to keep in sync.
    const player = new Player();
    player.nickname = (options.nickname || "Player").slice(0, 16);
    player.isOwner = this.state.players.size === 0;
    player.ready = true;
    player.connected = true;

    this.state.players.set(client.sessionId, player);

    this.setMetadata({ ...this.metadata, playerCount: this.state.players.size });
  }

  async onLeave(client, consented) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    // Only an explicit kick/leave skips the reconnection grace period. We do
    // NOT trust the `consented` flag alone here: navigating from
    // play/index.html to game/index.html via window.location.href can make
    // the browser send a "going away" close that Colyseus classifies as
    // consented, which used to skip allowReconnection() entirely — so
    // game/index.html's very first reconnect() attempt always failed with
    // "token invalid or expired," because no reconnection was ever actually
    // granted. "leaveLobby" (sent by Leave/Back/Close-lobby-triggered leaves,
    // client-side) is the one reliable signal that this is intentional.
    if (this.noReconnectSessionIds.has(client.sessionId)) {
      this.noReconnectSessionIds.delete(client.sessionId);
      this.removePlayer(client);
      return;
    }

    // Every player — owner or guest, lobby or in-game — gets the same short
    // reconnection grace on an unintentional drop (refresh, flaky wifi, tab
    // close without an explicit Leave/Back). What happens if they *don't*
    // come back in time differs by role below, not whether they get a grace
    // period at all: a guest refreshing shouldn't behave any differently
    // from the owner refreshing, from the guest's own point of view.
    const wasOwner = player.isOwner;
    player.connected = false;

    // Only the OWNER's absence takes the room off the public list and
    // blocks new joins while we wait for them — this is what keeps a
    // half-second owner refresh from ever being visible to anyone else. A
    // guest going quiet does NOT lock the room: the lobby still has a live
    // owner running it, so it stays fully joinable and functional the whole
    // time a guest is mid-reconnect. (Only relevant pre-start — a started
    // game was never in the public list to begin with.)
    const holdsLobbyLock = wasOwner && !this.state.started;
    if (holdsLobbyLock) this.lock();

    const graceSeconds = this.state.started ? 15 : LOBBY_RECONNECT_GRACE_SECONDS;

    try {
      await this.allowReconnection(client, graceSeconds);
      player.connected = true;
      if (holdsLobbyLock) this.unlock();
    } catch (e) {
      // Owner never came back in time — unlock unconditionally before
      // handing off, so the lock never outlives the reconnection attempt
      // it existed for. removePlayer() below reassigns ownership to the
      // next connected player using the existing reassignment logic.
      if (holdsLobbyLock) this.unlock();
      this.removePlayer(client);
    }
  }

  removePlayer(client) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    // Fixes the original zombie-tank bug: a confirmed-gone player's tank
    // is eliminated for real, exactly like dying in combat. selfDestruct()
    // already handles score/parachute bookkeeping, turn advancement (if it
    // was their turn), level-switch, and game-over — all for free.
    if (this.state.started && this.game && this.sessionToLetter) {
      const letter = this.sessionToLetter.get(client.sessionId);
      const tank = letter && this.game.players.get(letter);
      if (tank && this.game.remainingTanks.includes(letter)) {
        tank.selfDestruct(this.game, 0);
        const exp = tank.projectile.explosion;
        this.broadcast("tankExploded", { x: exp.x, y: exp.y, radius: exp.radius });
        this.syncFullState();
      }
    }

    this.state.players.delete(client.sessionId);
    this.state.tanks.delete(client.sessionId);

    // No letter bookkeeping needed here pre-game — letters aren't assigned
    // until "start" (see onJoin's comment), so there's nothing to free or
    // re-letter on a pre-game leave. Post-game, sessionToLetter is left
    // exactly as-is: once started, the mapping is load-bearing for the
    // rest of the match (turn resolution, scoring by letter, etc.) and
    // must never change.

    if (player.isOwner) {
      // Prefer a still-connected guest — with lobby reconnection grace now
      // in play, the "first" remaining player (Map insertion order) could
      // itself be mid-reconnect. Falling back to the first entry regardless
      // keeps a single guaranteed owner even in the unlikely case everyone
      // left is momentarily disconnected.
      const entries = [...this.state.players.entries()];
      const nextEntry = entries.find(([, p]) => p.connected) || entries[0];
      if (nextEntry) {
        const [, nextPlayer] = nextEntry;
        nextPlayer.isOwner = true;
        this.state.ownerNickname = nextPlayer.nickname;
      }
    }

    this.setMetadata({ ...this.metadata, playerCount: this.state.players.size });

    if (this.state.players.size === 0) {
      this.disconnect();
    }
  }
}

module.exports = { TankRoom };
