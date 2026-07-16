// rooms/logic/GameLogic.js
// Port of client GameLogic.js. This is now the single authority for turn
// order, elimination, level progression, and scoring — TurnManager.js
// has been removed since it duplicated this same bookkeeping in a
// parallel, session-keyed structure. TankRoom.js is responsible for
// translating game.currentPlayer (a board letter) into the session id
// that actually holds the turn, since Colyseus/clients key off sessions.
//
// Removed vs. the client version: `sprites` (a p5/browser asset cache —
// meaningless on the server, and only ever used by Tank.deployParachute(),
// which was rendering-only and has been dropped from server Tank.js).

const { Board } = require('./Board');
const { Tank } = require('./Tank');
const { createRng } = require('./Rng');
const { findNextAlive } = require('./utils');
const { FPS, INITIAL_PARACHUTES } = require('./constants');
const { resolvePlayerColour } = require('./colour');

class GameLogic {
  static FPS = FPS;
  static INITIAL_PARACHUTES = INITIAL_PARACHUTES;

  constructor(config, levelLayouts, seed, activeLetters) {
    this.config = config;
    this.levelLayouts = levelLayouts; // { 'level1.txt': [lines], ... }

    // Fixed at game start (see TankRoom.js) — which board letters actually
    // have a joined session behind them. Without this, generateLevel()
    // would create a Tank for every start position the layout defines,
    // even ones nobody joined as (a layout built for 4 players still
    // defines A-D even if only 2 people are in the room) — those phantom
    // tanks would sit uncontrolled forever, still counted in
    // remainingTanks, silently breaking isLevelOver()/isGameOver().
    this.activeLetters = activeLetters ?? null; // null = no filtering (local/offline testing)

    // Server always has a real seed (generated at game start and
    // broadcast once for parity/replay purposes) — the Date.now()
    // fallback only matters for local testing without a room.
    this.rng = createRng(seed ?? Date.now());

    this.currentLevel = 1; // 1-indexed, matches App.java
    this.board = new Board();

    this.players = new Map(); // id -> Tank
    this.damagedTanks = new Set();
    this.remainingTanks = []; // ids still alive this level

    this.playerIDs = [];
    this.playerScores = [];
    this.playerParachutes = [];

    this.playerIndex = 0;
    this.currentPlayer = null;
    this.nextPlayer = null;

    this.wind = 0;

    this.backgroundImageName = 'basic.png';
    this.terrainColour = [120, 171, 0];
    this.treeImageName = 'tree1.png';

    this.gameEnded = false;

    this.generateLevel();
  }

  get terrainPosition() { return this.board.terrainPosition; }
  get trees() { return this.board.trees; }

  generateLevel() {
    this.players.clear();
    this.damagedTanks.clear();

    const levelConfig = this.config.levels[this.currentLevel - 1];
    const layoutLines = this.levelLayouts[levelConfig.layout] ?? [];

    this.board.loadLayout(layoutLines);

    this.backgroundImageName = levelConfig.background ?? 'basic.png';
    this.treeImageName = levelConfig.trees ?? 'tree1.png';

    // foreground-colour is still a "r,g,b" string in config.json (unlike
    // player_colours, which is now { rgb: [r,g,b], name } per letter) —
    // no "random" option ever applies here, so this simple inline parse
    // is unchanged.
    const colourParts = (levelConfig['foreground-colour'] ?? '0,0,0').split(',').map(Number);
    this.terrainColour = colourParts.length === 3 ? colourParts : [0, 0, 0];

    // NOTE: tanks are created *before* this.playerIDs/playerScores below
    // are reassigned, so Tank's constructor still sees last level's
    // arrays and can carry scores/parachutes forward - mirrors the same
    // (load-bearing) ordering quirk in App.generateLevel().
    for (const start of this.board.playerStarts) {
      if (this.activeLetters && !this.activeLetters.includes(start.id)) continue;

      const tank = new Tank(start.id, start.x, start.y, this);

      // Colour resolution (config lookup + random fallback for an
      // unconfigured letter) lives in colour.js now — shared with
      // TankRoom's own lobby-facing colour assignment.
      tank.setColour(resolvePlayerColour(this.config, start.id));

      this.players.set(start.id, tank);
    }

    this.wind = Math.floor(this.rng() * 71) - 35; // -35..35

    // JS Map iterates in insertion order (board-scan order), but Java's
    // HashMap<Character,Tank> happened to iterate single-letter keys
    // alphabetically regardless of scan order - sort here to match, with
    // letters (A-Z) ordered before digits (0-9) rather than default
    // string sort (which would put digits first).
    this.playerIDs = Array.from(this.players.keys()).sort((a, b) => {
      const aIsDigit = a >= '0' && a <= '9';
      const bIsDigit = b >= '0' && b <= '9';
      if (aIsDigit !== bIsDigit) return aIsDigit ? 1 : -1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    this.playerScores = new Array(this.playerIDs.length).fill(0);
    this.playerParachutes = new Array(this.playerIDs.length).fill(GameLogic.INITIAL_PARACHUTES);
    this.remainingTanks = [...this.playerIDs];

    this.playerIndex = 0;
    this.playerOrder();
  }

  playerOrder() {
    const { id, index } = findNextAlive(this.playerIDs, this.remainingTanks, this.playerIndex);
    this.currentPlayer = id;
    this.playerIndex = index;
    this.nextPlayer = this.playerIDs[(this.playerIndex + 1) % this.playerIDs.length];

    this.wind += Math.floor(this.rng() * 11) - 5; // -5..5 drift
    this.playerIndex++;
  }

  levelSwitch() {
    this.currentLevel++;
    this.playerIndex = 0;
    this.generateLevel();
  }

  // descending bubble sort of playerIDs/playerScores by score, matching
  // App.getWinner()'s exact algorithm
  getWinner() {
    for (let i = 0; i < this.playerScores.length - 1; i++) {
      for (let j = 0; j < this.playerScores.length - i - 1; j++) {
        if (this.playerScores[j] < this.playerScores[j + 1]) {
          [this.playerScores[j], this.playerScores[j + 1]] = [this.playerScores[j + 1], this.playerScores[j]];
          [this.playerIDs[j], this.playerIDs[j + 1]] = [this.playerIDs[j + 1], this.playerIDs[j]];
        }
      }
    }
  }

  restartGame() {
    this.currentLevel = 1;
    this.gameEnded = false;
    this.generateLevel(); // fresh scores/parachutes fall out of this naturally
  }

  isLevelOver() {
    return this.remainingTanks.length <= 1;
  }

  isGameOver() {
    return this.isLevelOver() && this.currentLevel === this.config.levels.length;
  }
}

module.exports = { GameLogic };
