// rooms/logic/Board.js
//
// Parses a level layout into terrain/trees/player spawns. Depends on
// shared/constants and Cell — the two smallest pieces below it.

const { CELLSIZE, WIDTH, HEIGHT, GRID_WIDTH, GRID_HEIGHT } = require('../../shared/constants');
const { Cell } = require('./Cell');

/**
 * Board represents a single level's playfield.
 *
 * A level is authored as an ASCII grid (see level1.txt) where each
 * character maps to a Cell type (terrain, tree, player spawn, or empty).
 * Board converts that grid into:
 *   - `cells`: the 2D grid of Cell instances (row-major).
 *   - `terrainPosition`: a 1D pixel-indexed heightmap used for rendering
 *     and collision (terrainPosition[x] = y-coordinate of the ground at
 *     pixel column x), smoothed into a gentle slope instead of blocky steps.
 *   - `trees` / `playerSpawns`: derived entity lists pulled out of the grid.
 */
class Board {
  static CELLSIZE = CELLSIZE;
  static WIDTH = WIDTH;
  static HEIGHT = HEIGHT;
  static GRID_WIDTH = GRID_WIDTH;
  static GRID_HEIGHT = GRID_HEIGHT;

  /** Number of box-blur passes applied to the terrain heightmap. Higher = smoother/gentler slopes. */
  static SMOOTHING_PASSES = 2;

  constructor() {
    this.cells = [];
    this.terrainPosition = new Array(Board.WIDTH + Board.CELLSIZE).fill(Board.HEIGHT);
    this.trees = [];
    this.playerSpawns = [];
  }

  /**
   * Load a level from raw ASCII lines, replacing any previously loaded state.
   *
   * Pipeline: normalize the raw text into a fixed-size grid -> build Cells
   * and the raw (blocky) terrain heightmap -> smooth the heightmap ->
   * derive entity lists (trees, player spawns) from the finished board.
   *
   * @param {string[]} rawLines - Lines of the level file, one string per row.
   *                              Missing/short lines are treated as blank.
   */
  loadLayout(rawLines) {
    const padded = this.#normalizeLines(rawLines);

    this.#buildCellsAndTerrain(padded);

    for (let i = 0; i < Board.SMOOTHING_PASSES; i++) {
      this.smoothing();
    }

    this.#collectEntities();
  }

  // --- Step 1: text normalization -----------------------------------------

  /**
   * Pad/truncate raw level text to exactly GRID_WIDTH x GRID_HEIGHT.
   * Strips trailing CR (Windows line endings) and pads short/missing
   * rows and columns with spaces so every row can be indexed safely.
   *
   * @param {string[]} rawLines
   * @returns {string[]} Exactly GRID_HEIGHT lines, each exactly GRID_WIDTH chars.
   */
  #normalizeLines(rawLines) {
    const lines = (rawLines ?? []).map(l => l.replace(/\r$/, ''));

    const padded = lines.map(line =>
      line.length < Board.GRID_WIDTH ? line + ' '.repeat(Board.GRID_WIDTH - line.length) : line
    );
    while (padded.length < Board.GRID_HEIGHT) {
      padded.push(' '.repeat(Board.GRID_WIDTH));
    }

    return padded;
  }

  // --- Step 2: grid -> Cells + raw terrain heightmap ------------------------

  /**
   * Build `this.cells` from the normalized grid text, and stamp a blocky
   * (pre-smoothing) terrain heightmap into `this.terrainPosition` for every
   * TERRAIN cell encountered. Each terrain cell covers a CELLSIZE-wide strip
   * of pixel columns.
   *
   * @param {string[]} padded - Normalized grid lines (see #normalizeLines).
   */
  #buildCellsAndTerrain(padded) {
    this.cells = [];
    this.terrainPosition = new Array(Board.WIDTH + Board.CELLSIZE).fill(Board.HEIGHT);

    for (let row = 0; row < Board.GRID_HEIGHT; row++) {
      const cellRow = [];
      const line = padded[row] ?? '';

      for (let col = 0; col < Board.GRID_WIDTH; col++) {
        const c = line[col] ?? ' ';
        const cell = new Cell(c);
        cellRow.push(cell);

        if (cell.type === Cell.Type.TERRAIN) {
          this.#stampTerrainColumn(row, col);
        }
      }
      this.cells.push(cellRow);
    }
  }

  /**
   * Write this row's y-coordinate into every pixel column covered by the
   * terrain cell at (row, col). Silently skips pixels beyond the array
   * bounds (relies on GRID_WIDTH * CELLSIZE lining up with WIDTH).
   *
   * @param {number} row - Grid row of the terrain cell.
   * @param {number} col - Grid column of the terrain cell.
   */
  #stampTerrainColumn(row, col) {
    for (let j = 0; j < Board.CELLSIZE; j++) {
      const px = col * Board.CELLSIZE + j;
      if (px < this.terrainPosition.length) {
        this.terrainPosition[px] = row * Board.CELLSIZE;
      }
    }
  }

  // --- Step 3: smoothing ----------------------------------------------------

  /**
   * Apply one box-blur pass over `terrainPosition`, turning stepped terrain
   * into a smoother slope. Averages each pixel with the next CELLSIZE-1
   * neighbors to its right.
   *
   * Safe to mutate in place: the loop writes left-to-right and each write
   * only reads indices >= its own, so it never reads a value already
   * overwritten earlier in the same pass. Reordering this loop would break
   * that assumption.
   */
  smoothing() {
    for (let x = 0; x < this.terrainPosition.length - Board.CELLSIZE; x++) {
      let sum = 0;
      for (let c = 0; c < Board.CELLSIZE; c++) {
        sum += this.terrainPosition[x + c];
      }
      this.terrainPosition[x] = Math.floor(sum / Board.CELLSIZE);
    }
  }

  // --- Step 4: derived entities ---------------------------------------------

  /**
   * Scan the finished `cells` grid and populate `this.trees` and
   * `this.playerSpawns` from TREE and PLAYER_SPAWN cells respectively.
   * Player spawn y-coordinates are taken from the (already smoothed)
   * terrain heightmap at the spawn's x-coordinate, so spawns sit on
   * the ground rather than at their literal grid row.
   *
   * Note: if a layout reuses the same spawn letter twice, both spawns
   * are kept with the same `id` — callers should not assume `id` is unique.
   */
  #collectEntities() {
    this.trees = [];
    this.playerSpawns = [];

    for (let row = 0; row < this.cells.length; row++) {
      for (let col = 0; col < this.cells[row].length; col++) {
        const cell = this.cells[row][col];

        if (cell.type === Cell.Type.TREE) {
          this.trees.push(col * Board.CELLSIZE);
        } else if (cell.type === Cell.Type.PLAYER_SPAWN) {
          const x = col * Board.CELLSIZE;
          const y = this.terrainPosition[x];
          this.playerSpawns.push({ id: cell.id, x, y });
        }
      }
    }
  }
}

module.exports = { Board };