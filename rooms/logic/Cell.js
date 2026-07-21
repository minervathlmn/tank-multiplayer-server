// rooms/logic/Cell.js
//
// One grid square's type/id, parsed from a level layout character. No
// local requires — sits at the bottom of the dependency graph.

/**
 * Cell represents a single square in a Board's grid.
 *
 * Each cell is constructed from a single character taken from a level's
 * ASCII layout (see level1.txt). The character determines both the cell's
 * `type` and its `id` (used as-is for player spawn letters, e.g. 'A', 'B').
 */
class Cell {
  /** Possible cell types, derived from the character used to build a Cell. */
  static Type = {
    TERRAIN: 'terrain',
    PLAYER_SPAWN: 'player_spawn',
    TREE: 'tree',
    SPACE: 'empty',
  };

  /**
   * Map a single layout character to its Cell type.
   *
   * Rules (checked in order — 'X' and 'T' fall inside 'A'-'Z' so they
   * must be checked before the general player-spawn range):
   *   'X'        -> TERRAIN
   *   'T'        -> TREE
   *   'A'-'Z'     -> PLAYER_SPAWN (the letter itself becomes the spawn id)
   *   anything else (including spaces) -> SPACE
   *
   * @param {string} c - A single character from a level layout.
   * @returns {string} One of Cell.Type's values.
   */
  static typeOf(c) {
    if (c === 'X') return Cell.Type.TERRAIN;
    if (c === 'T') return Cell.Type.TREE;
    if (c >= 'A' && c <= 'Z') return Cell.Type.PLAYER_SPAWN;
    return Cell.Type.SPACE;
  }

  /**
   * @param {string} c - The layout character this cell was built from.
   *                      Stored as `id` and used to derive `type`.
   */
  constructor(c) {
    this.id = c;
    this.type = Cell.typeOf(c);
    /** @type {?object} The tank occupying this cell, if any. */
    this.tank = null;
  }

  /**
   * Mark this cell as an occupied player spawn and attach a tank to it.
   * Used when a tank actually spawns into the board, as opposed to a
   * cell merely being an available spawn point in the layout.
   *
   * @param {object} tank - The tank instance now occupying this cell.
   */
  setPlayer(tank) {
    this.type = Cell.Type.PLAYER_SPAWN;
    this.tank = tank;
  }
}

module.exports = { Cell };