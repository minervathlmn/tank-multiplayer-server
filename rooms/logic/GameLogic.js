// rooms/logic/GameLogic.js
//
// Single source of truth for one match's server-side simulation state.
// Depends on shared/constants, utils, Rng, Board, and Tank — everything
// else in rooms/logic/.

const { FPS, INITIAL_PARACHUTES } = require('../../shared/constants');
const { resolvePlayerColour } = require('./utils');
const { createRng } = require('./Rng');
const { Board } = require('./Board');
const { Tank } = require('./Tank');

/**
 * GameLogic is the single source of truth for one match's server-side
 * simulation state: the current level's board, every Tank, turn order,
 * wind, scores/parachutes, and win/loss. TankRoom drives it by calling
 * into Tank/Bot per tick and reading its public fields to broadcast state;
 * GameLogic itself never touches networking or Colyseus session ids.
 */
class GameLogic {
  static FPS = FPS;
  static INITIAL_PARACHUTES = INITIAL_PARACHUTES;

  /**
   * @param {object} config - Parsed levels/config.json (levels array + player_colours).
   * @param {Object.<string, string[]>} levelLayouts - Map of layout filename
   *   (e.g. 'level1.txt') to its raw ASCII lines, as consumed by Board.loadLayout().
   * @param {number} [seed] - Seed for the deterministic RNG driving wind
   *   (and bot decisions, via game.rng). Falls back to Date.now() for local/offline
   *   testing — TankRoom always supplies a real seed for parity/replay.
   * @param {string[]|null} [activeLetters] - Board letters that actually have a
   *   joined session behind them; only these get a Tank in generateLevel().
   *   null disables filtering (every spawn in the layout gets a Tank).
   */
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

  // --- Derived read-only board accessors ------------------------------
  // Thin passthroughs so callers (Tank, Bot, TankRoom) can read
  // game.terrainPosition / game.trees without reaching into game.board
  // directly — keeps Board an implementation detail of GameLogic.

  /** @returns {number[]} Pixel-indexed terrain heightmap for the current level (see Board.js). */
  get terrainPosition() { return this.board.terrainPosition; }

  /** @returns {number[]} X pixel-columns of tree cells for the current level (see Board.js). */
  get trees() { return this.board.trees; }

  // --- Level generation --------------------------------------------------

  /**
   * (Re)build the current level from scratch: loads the level's board
   * layout, creates one Tank per active player spawn (carrying forward
   * score/parachutes from the previous level where applicable), rolls a
   * fresh wind, and sets up turn order. Called from the constructor for
   * level 1, and again by levelSwitch()/restartGame() for subsequent
   * levels or a fresh game.
   */
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
    for (const start of this.board.playerSpawns) {
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

  // --- Turn order ----------------------------------------------------------

  /**
   * Advance whose turn it is: finds the next living player at/after
   * playerIndex (wrapping around playerIDs), sets currentPlayer/nextPlayer
   * accordingly, and applies a small random drift to wind. Called after
   * generateLevel() sets up a fresh round, and again whenever the current
   * player's tank is destroyed (see Tank.selfDestruct()).
   */
  playerOrder() {
    const { id, index } = findNextAlive(this.playerIDs, this.remainingTanks, this.playerIndex);
    this.currentPlayer = id;
    this.playerIndex = index;
    this.nextPlayer = this.playerIDs[(this.playerIndex + 1) % this.playerIDs.length];

    this.wind += Math.floor(this.rng() * 11) - 5; // -5..5 drift
    this.playerIndex++;
  }

  /**
   * Advance to the next level: increments currentLevel, resets turn order
   * to the start of playerIDs, and regenerates the board/tanks via
   * generateLevel(). Called by Tank.selfDestruct() once only one tank
   * remains and the match isn't on its last level yet.
   */
  levelSwitch() {
    this.currentLevel++;
    this.playerIndex = 0;
    this.generateLevel();
  }

  // --- Win / loss / restart -------------------------------------------

  /**
   * Sort playerIDs and playerScores together, descending by score, so
   * playerIDs[0] is the match winner. Mutates both arrays in place —
   * descending bubble sort, matching App.getWinner()'s exact algorithm
   * (kept identical rather than swapped for a stdlib sort, so tie-breaking
   * order stays byte-for-byte consistent with the client's original logic).
   */
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

  /**
   * Reset the match back to level 1 with a clean gameEnded flag. Scores
   * and parachutes aren't reset explicitly — generateLevel() rebuilds
   * playerScores/playerParachutes from scratch, and new Tanks are created
   * with no prior-level entry to carry forward, so they naturally start fresh.
   */
  restartGame() {
    this.currentLevel = 1;
    this.gameEnded = false;
    this.generateLevel(); // fresh scores/parachutes fall out of this naturally
  }

  /** @returns {boolean} Whether the current level has one or zero tanks left standing. */
  isLevelOver() {
    return this.remainingTanks.length <= 1;
  }

  /** @returns {boolean} Whether the level that just ended was also the match's last configured level. */
  isGameOver() {
    return this.isLevelOver() && this.currentLevel === this.config.levels.length;
  }
}

/**
 * Find the next living player at or after fromIndex, wrapping around
 * playerIDs as many times as needed (bounded by a safety guard).
 *
 * @param {string[]} playerIDs - All player ids for the current level, in turn order.
 * @param {string[]} remainingTanks - Ids still alive this level.
 * @param {number} fromIndex - Index into playerIDs to start searching from
 *   (not pre-wrapped — may already exceed playerIDs.length, see playerOrder()).
 * @returns {{id: string, index: number}} The next living player's id, and
 *   the (possibly un-wrapped) index it was found at. Falls back to
 *   `playerIDs[fromIndex % playerIDs.length]` if no living player is found
 *   within the guard limit (e.g. every remaining tank died the same tick).
 */
function findNextAlive(playerIDs, remainingTanks, fromIndex) {
  let idx = fromIndex;
  let guard = 0; // safety net against an all-dead edge case looping forever
  while (guard++ < 1000) {
    const candidate = playerIDs[idx % playerIDs.length];
    if (remainingTanks.includes(candidate)) {
      return { id: candidate, index: idx };
    }
    idx++;
  }
  return { id: playerIDs[fromIndex % playerIDs.length], index: fromIndex };
}

module.exports = { GameLogic };