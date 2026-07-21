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
const { MAX_PLAYERS } = require('../shared/constants');
const { radians, sin, cos, resolvePlayerColour, buildColourNameLookup } = require('./logic/utils');
const { Board } = require('./logic/Board');
const { Explosion } = require('./logic/Explosion');
const { GameLogic } = require('./logic/GameLogic');
const { Bot } = require('./logic/Bot');
const { TankState } = require('./schema/TankState');
const { TankRoomState, Player } = require('./schema/TankRoomState');

// Single source of truth for room capacity. Bump this to raise or lower
// the player cap — LETTERS below and Room.maxClients (see onCreate) both
// derive from it, so nothing else needs to change to add/remove seats.
// Caps out at 26 (Z) since letters are generated via charCode arithmetic;
// a design wanting more than 26 seats would need a different labeling
// scheme entirely, not just a bigger number here.
// const MAX_PLAYERS = 4;

// Board letters assigned by join/add order, locked in once at "start" —
// room creator is always 'A', next seat 'B', etc., based on this.state.players'
// order at that moment (see the "start" handler and onJoin's comment for why).
// Bots are opt-in, not automatic (see "addBot"): a started game fields
// exactly as many tanks as there are occupied seats — human or bot — which
// may be fewer than MAX_PLAYERS.
// This assumes every level layout defines start positions for these exact
// letters; if a layout ever doesn't, "start" fails loudly (see below)
// rather than silently spawning a mismatched or missing tank.
const LETTERS = Array.from({ length: MAX_PLAYERS }, (_, i) => String.fromCharCode(65 + i));

// Bots don't have a real Colyseus sessionId, but every place that keys off
// "whose turn/tank is this" (sessionToLetter, letterToSession, state.tanks,
// state.players, currentTurnSessionId) is written generically around "some
// id string that identifies a seat" — so bots get a synthetic id in that
// same shape rather than a parallel bot-specific set of maps. No real
// client.sessionId can ever collide with this, which is also what
// naturally keeps human "action" messages from being accepted during a
// bot's turn (see the "action" handler's currentTurnSessionId check) with
// no extra bot-aware guard needed.
//
// The id is assigned once, at "addBot" time (see onCreate), from a
// room-scoped sequence counter — not derived from the bot's eventual board
// letter, since bots now exist as lobby seats before any letter is
// assigned (letters are only handed out at "start", same as for humans).
function botSeatId(seq) {
  return `bot:${seq}`;
}

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
  const levelsDir = path.join(__dirname, '../shared/levels');
  const config = JSON.parse(fs.readFileSync(path.join(levelsDir, 'config.json'), 'utf-8'));

  const levelLayouts = {};
  for (const level of config.levels) {
    const raw = fs.readFileSync(path.join(levelsDir, level.layout), 'utf-8');
    levelLayouts[level.layout] = raw.split('\n');
  }

  return { config, levelLayouts };
}

/**
 * One instance of this = one lobby/game (see file header for the overall
 * server-authoritative model). Owns the Colyseus room lifecycle (join/
 * leave/reconnect), the lobby-to-game transition ("start"), routing
 * player input into GameLogic, and syncing GameLogic's plain-JS
 * simulation state onto the networked TankRoomState schema every tick.
 */
class TankRoom extends Room {
  maxClients = MAX_PLAYERS;

  /**
   * Colyseus lifecycle hook: room instance created. Loads level config,
   * initializes lobby/game bookkeeping (all still empty — no game exists
   * until "start"), and registers every message handler for the lifetime
   * of this room.
   *
   * @param {object} options - Room creation options from the client that
   *   created it: { isPrivate, nickname, botDifficulty }.
   * @returns {void}
   */
  onCreate(options) {
    this.setState(new TankRoomState());

    const { config, levelLayouts } = loadLevels();
    this.config = config;
    this.levelLayouts = levelLayouts;
    this.colourNames = buildColourNameLookup(config);

    this.game = null;             // GameLogic instance, created at "start"
    this.sessionToLetter = new Map(); // populated once, at "start" — see onJoin's comment
    this.letterToSession = new Map(); // human sessionIds AND bot synthetic ids (see botSeatId)
    this.noReconnectSessionIds = new Set(); // explicit kicks/leaves — onLeave skips reconnection grace for these

    this.bots = new Map();        // letter -> Bot instance, only for AI-filled seats, populated at "start"
    this.activeBotLetter = null;  // letter whose Bot.startTurn() has already run this turn; reset whenever
                                   // currentPlayer changes (fire, disconnect-elimination, restart) so the
                                   // next bot turn (if any) gets a fresh startTurn() call
    this.nextBotSeq = 1;          // room-scoped counter for botSeatId() — see "addBot" below
    const validDifficulties = ["easy", "medium", "hard", "expert"];
    this.botDifficulty = validDifficulties.includes(options.botDifficulty) ? options.botDifficulty : "medium";

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

    // Bots are opt-in: the host adds each one explicitly (e.g. a "+ BOT"
    // button in the lobby), rather than every unfilled seat auto-becoming
    // a bot at start. A bot occupies a real seat in this.state.players —
    // same map humans join into — so it counts against the same capacity
    // check onJoin already enforces, shows up in the same unified lobby
    // list, and "start" (below) treats it identically to a human seat when
    // assigning board letters.
    this.onMessage("addBot", (client) => {
      const requester = this.state.players.get(client.sessionId);
      if (!requester || !requester.isOwner) return;
      if (this.state.started) return;
      if (this.state.players.size >= LETTERS.length) return; // lobby full — same cap onJoin enforces

      const bot = new Player();
      bot.nickname = `Bot (${this.botDifficulty})`;
      bot.isBot = true;
      bot.ready = true;      // bots never block the "allReady" check in "start"
      bot.connected = true;

      this.state.players.set(botSeatId(this.nextBotSeq++), bot);
      this.setMetadata({ ...this.metadata, playerCount: this.state.players.size });
    });

    this.onMessage("removeBot", (client, payload) => {
      const requester = this.state.players.get(client.sessionId);
      if (!requester || !requester.isOwner) return;
      if (this.state.started) return;

      const targetId = payload?.botId;
      const target = targetId && this.state.players.get(targetId);
      if (!target || !target.isBot) return;

      this.state.players.delete(targetId);
      this.setMetadata({ ...this.metadata, playerCount: this.state.players.size });
    });

    // --- start ------------------------------------------------------------

    this.onMessage("start", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.isOwner) return;
      if (this.state.started) return;

      const allReady = [...this.state.players.values()].every((p) => p.ready);
      if (!allReady || this.state.players.size < 2) return;

      // Every occupied seat — human or bot, whichever order they joined/were
      // added in — gets a letter. Unlike before, there's no padding out to
      // MAX_PLAYERS: a lobby of 2 humans and 0 bots starts a 2-tank game.
      const seatIds = [...this.state.players.keys()]; // owner first, forever
      if (seatIds.length > LETTERS.length) return; // shouldn't happen — onJoin/addBot both cap below this

      const seed = Math.floor(Math.random() * 2 ** 31);

      // Letters are assigned here, fresh, from current join/add order — not
      // maintained incrementally through the lobby (see onJoin's comment).
      // Rebuilding both maps from scratch each time this handler runs is
      // deliberate: it's idempotent, so a failed start attempt below
      // (missing level start positions) just gets silently recomputed
      // identically — or differently, if someone left/joined — on the
      // next attempt, with no stale state to clean up either way.
      this.sessionToLetter.clear();
      this.letterToSession.clear();
      this.bots.clear();
      this.activeBotLetter = null;

      seatIds.forEach((id, i) => {
        const letter = LETTERS[i];
        const seat = this.state.players.get(id);

        this.letterToSession.set(letter, id);
        seat.letter = letter;
        seat.color = resolvePlayerColour(this.config, letter).join(",");

        if (seat.isBot) {
          this.bots.set(letter, new Bot(letter, this.botDifficulty));
        } else {
          this.sessionToLetter.set(id, letter);
        }
      });

      const activeLetters = LETTERS.slice(0, seatIds.length);

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

      for (const id of seatIds) {
        const seat = this.state.players.get(id);
        const tankState = new TankState();
        tankState.letter = seat.letter;
        tankState.nickname = seat.isBot ? seat.nickname : (seat.nickname || `Player ${seat.letter}`);
        tankState.isBot = seat.isBot;
        this.state.tanks.set(id, tankState);
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
        this.fireTank(letter);
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
      this.activeBotLetter = null;

      this.game.restartGame();
      this.syncFullState();
      this.broadcast("restart");
    });
  }

  // --- Turn-resolution + state-sync helpers (used by both human "action"
  // handling above and updateBots() below) ------------------------------

  /**
   * Fires whichever tank holds `letter`'s turn right now and passes the
   * turn. Shared by the human "action"/"fire" handler and updateBots() —
   * originally this logic only lived inline in the "action" handler, but
   * a Bot deciding to fire needs to trigger the exact same sequence with
   * no human client or "action" message involved.
   *
   * @param {string} letter - Board letter of the tank firing.
   * @returns {void}
   */
  fireTank(letter) {
    const tank = this.game.players.get(letter);
    if (!tank) return;

    tank.stopAdjustment();
    // Read *before* setFire() below, so this reflects whichever state was
    // active at the moment of firing regardless of anything setFire()/
    // tick() does to the flag afterward (see Projectile.js's own reset points).
    const doubleBlastRadius = tank.projectile.doubleBlastRadius;
    tank.projectile.setFire(this.game, tank);

    // Cosmetic-only: lets clients replay the same simple trajectory
    // locally for the shell/explosion animation. The server has already
    // resolved the real outcome (damage, terrain) by the time this
    // arrives — this is purely so clients see something. For a bot shot,
    // shooterSessionId is the synthetic botSeatId — clients that look the
    // shooter up in state.tanks (keyed the same way) resolve it fine with
    // no bot-specific handling needed on their end.
    this.broadcast("shotFired", {
      shooterSessionId: this.letterToSession.get(letter) ?? "",
      startX: tank.projectile.x,
      startY: tank.projectile.y,
      angle: tank.projectile.angle,
      power: tank.projectile.power,
      doubleBlastRadius,
    });

    this.game.playerOrder(); // confirmed from sketch.js: turn passes immediately on fire

    // Sync the new turn holder right now rather than waiting for the next
    // simulation tick's update() to do it. Without this, a second "action"
    // message arriving before the next tick (e.g. a fast double-tap of
    // fire) would still pass the `client.sessionId !==
    // this.state.currentTurnSessionId` check above against the stale,
    // pre-turn-pass value — letting the same client fire twice and call
    // playerOrder() an extra time, which (with 2 players) flips the turn
    // forward and immediately back, leaving currentPlayer/
    // currentTurnSessionId desynced.
    this.state.currentTurnSessionId = this.letterToSession.get(this.game.currentPlayer) ?? "";

    // Whoever's turn it is now (human or bot) starts fresh — see
    // updateBots() for why this matters even when the new turn is human.
    this.activeBotLetter = null;
  }

  /**
   * Drives whichever Bot currently holds the turn, if any. Bots "play" by
   * holding the same rotate/power flags a real client's "action" messages
   * would set on their Tank (see Bot.js's own header) — Tank.tick(), called
   * right after this in update()'s per-tank loop, is what actually turns
   * those flags into turretAngle/power changes, exactly as it does for a
   * human's queued input. Call this before that per-tank loop each tick so
   * a flag a bot sets this frame gets applied within the same frame.
   *
   * @param {number} dt - Seconds elapsed since the last simulation tick.
   * @returns {void}
   */
  updateBots(dt) {
    const game = this.game;
    const letter = game.currentPlayer;
    const bot = this.bots.get(letter);

    if (!bot) {
      // Current turn isn't a bot's — clear any stale tracking so that if
      // play comes back around to a bot later, it gets a fresh startTurn().
      this.activeBotLetter = null;
      return;
    }

    if (this.activeBotLetter !== letter) {
      bot.startTurn(game);
      this.activeBotLetter = letter;
    }

    const shouldFire = bot.tick(game, dt);
    if (shouldFire) {
      this.fireTank(letter); // also clears activeBotLetter, for whoever's up next
    }
  }

  /**
   * Copies everything from the plain-JS GameLogic/Tank simulation onto the
   * synced schema. Called at game start, on restart, and whenever a level
   * switch happens (board/tanks are rebuilt fresh by generateLevel()).
   *
   * @returns {void}
   */
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

  /**
   * Copies one Tank's simulation state onto its synced TankState. Called
   * both by syncFullState() (every field, once, at start/restart/level
   * switch) and directly from update()'s own per-tank loop every tick.
   *
   * @param {Tank} tank - Source of truth: the plain-JS simulation object.
   * @param {TankState} tankState - Synced schema instance to write onto.
   * @param {GameLogic} game - The active game, for `alive` (needs remainingTanks).
   * @returns {void}
   */
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

  /**
   * Fixed-rate simulation tick, running at GameLogic.FPS once the game has
   * started (see the "start" handler's setSimulationInterval call). Drives
   * bots, ticks every living tank + its projectile, broadcasts death
   * events, and syncs the result onto the schema — unless a level
   * transition is being deliberately held back (see the currentLevel
   * check below).
   *
   * @param {number} dt - Seconds elapsed since the last tick.
   * @returns {void}
   */
  update(dt) {
    if (!this.game || this.levelTransitionPending) return;
    const game = this.game;
    const levelBefore = game.currentLevel;

    this.updateBots(dt);

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

  // --- Colyseus lifecycle: join / leave / reconnect ---------------------

  /**
   * Colyseus lifecycle hook: a client is joining this room (lobby only —
   * see the `started` guard below).
   *
   * @param {Client} client - The joining Colyseus client.
   * @param {object} options - { nickname, code } from the client's join request.
   * @returns {void}
   * @throws {Error} If the game already started, the lobby is private and
   *   the code doesn't match, or the lobby is already full.
   */
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

  /**
   * Colyseus lifecycle hook: a client's connection dropped, intentionally
   * or not. Distinguishes an explicit leave/kick (skip reconnection grace,
   * remove immediately) from everything else (grant a short reconnection
   * grace before actually removing the player) — see the extensive inline
   * comments below for why `consented` alone can't be trusted for that
   * distinction.
   *
   * @param {Client} client - The disconnecting Colyseus client.
   * @param {boolean} consented - Colyseus's own guess at whether this was
   *   an intentional disconnect; not fully trusted here (see body).
   * @returns {Promise<void>}
   */
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

  /**
   * Fully removes a player from this room: eliminates their tank in-game
   * (if any, exactly like a combat death), clears their lobby/game state,
   * and reassigns ownership if they were the owner. Called both for a
   * confirmed-gone reconnection timeout and for an explicit kick/leave.
   *
   * @param {Client} client - The Colyseus client to remove.
   * @returns {void}
   */
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
        tank.selfDestruct(this.game, 0); // may itself advance the turn via playerOrder()
        this.activeBotLetter = null; // whoever holds the turn now (possibly a bot) starts fresh
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