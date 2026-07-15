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
const { randomColour } = require('./logic/colour');

// Board letters assigned by join order — room creator is always 'A', next
// joiner 'B', etc. Fixed the moment someone joins, not deferred to "start".
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

    this.game = null;             // GameLogic instance, created at "start"
    this.sessionToLetter = new Map(); // built incrementally as players join
    this.letterToSession = new Map();
    this.kickedSessionIds = new Set(); // tracks explicit kicks so onLeave can skip reconnection grace only for those

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

    this.onMessage("kickPlayer", (client, payload) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.isOwner) return;

      const targetSessionId = payload?.sessionId;
      if (!targetSessionId || targetSessionId === client.sessionId) return;

      const targetClient = this.clients.find((c) => c.sessionId === targetSessionId);
      if (!targetClient) return;

      this.kickedSessionIds.add(targetSessionId);
      targetClient.send("kicked");
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

      for (const sessionId of sessionIds) {
        const tankState = new TankState();
        tankState.letter = this.sessionToLetter.get(sessionId);
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
      } else if (type === "xtra") {
        tank.projectile.xtra(tank);
      } else {
        tank[type]();
      }
    });

    this.onMessage("restart", (client) => {
      if (!this.state.started || !this.game) return;
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
  }

  update(dt) {
    if (!this.game) return;
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
      if (!game.remainingTanks.includes(letter)) {
        const exp = tank.projectile.explosion;
        this.broadcast("tankExploded", { x: exp.x, y: exp.y, radius: exp.radius });
      }
    }

    // A level switch rebuilds board + all Tank instances inside GameLogic —
    // re-sync everything rather than trying to patch the diff.
    if (game.currentLevel !== levelBefore) {
      this.syncFullState();
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

    const letter = LETTERS.find((l) => !this.letterToSession.has(l));
    if (!letter) {
      throw new Error("This lobby is full.");
    }
    this.sessionToLetter.set(client.sessionId, letter);
    this.letterToSession.set(letter, client.sessionId);

    const configuredColour = this.config.player_colours?.[letter];
    const colour = Array.isArray(configuredColour) && configuredColour.length === 3
      ? configuredColour
      : randomColour();

    const player = new Player();
    player.nickname = (options.nickname || "Player").slice(0, 16);
    player.letter = letter;
    player.color = colour.join(",");
    player.isOwner = this.state.players.size === 0;
    player.ready = true;
    player.connected = true;

    this.state.players.set(client.sessionId, player);

    this.setMetadata({ ...this.metadata, playerCount: this.state.players.size });
  }

  async onLeave(client, consented) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    // Only an explicit kick skips the reconnection grace period. We do NOT
    // trust the `consented` flag alone here: navigating from play/index.html
    // to game/index.html via window.location.href can make the browser send
    // a "going away" close that Colyseus classifies as consented, which
    // used to skip allowReconnection() entirely — so game/index.html's very
    // first reconnect() attempt always failed with "token invalid or
    // expired," because no reconnection was ever actually granted.
    if (this.kickedSessionIds.has(client.sessionId)) {
      this.kickedSessionIds.delete(client.sessionId);
      this.removePlayer(client);
      return;
    }

    player.connected = false;
    try {
      await this.allowReconnection(client, 15);
      player.connected = true;
    } catch (e) {
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

    // Only free the letter for reuse pre-game — once started, the
    // sessionId<->letter mapping is load-bearing for the rest of the game
    // (turn resolution, scoring by letter, etc.) and must never change.
    if (!this.state.started) {
      const letter = this.sessionToLetter.get(client.sessionId);
      if (letter) {
        this.sessionToLetter.delete(client.sessionId);
        this.letterToSession.delete(letter);
      }
    }

    if (player.isOwner) {
      const nextSessionId = [...this.state.players.keys()][0];
      if (nextSessionId) {
        this.state.players.get(nextSessionId).isOwner = true;
        this.state.ownerNickname = this.state.players.get(nextSessionId).nickname;
      }
    }

    this.setMetadata({ ...this.metadata, playerCount: this.state.players.size });

    if (this.state.players.size === 0) {
      this.disconnect();
    }
  }
}

module.exports = { TankRoom };