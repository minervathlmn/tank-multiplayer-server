// rooms/logic/Cell.js
// Verbatim port of client Cell.js — pure data class, no changes needed.

class Cell {
  static Type = {
    TERRAIN: 'terrain',
    HUMAN_PLAYER: 'human_player',
    TREE: 'tree',
    SPACE: 'empty',
  };

  static typeRegister = new Map();

  constructor(c) {
    if (c === 'X') {
      Cell.typeRegister.set(c, Cell.Type.TERRAIN);
    } else if (c === 'T') {
      Cell.typeRegister.set(c, Cell.Type.TREE);
    } else if (c >= 'A' && c <= 'Z') {
      Cell.typeRegister.set(c, Cell.Type.HUMAN_PLAYER);
    } else if (c >= '0' && c <= '9') {
      Cell.typeRegister.set(c, Cell.Type.HUMAN_PLAYER);
    }

    this.id = c;
    this.type = Cell.typeRegister.get(c) ?? Cell.Type.SPACE;
    this.tank = null;
  }

  setHumanPlayer(tank) {
    this.type = Cell.Type.HUMAN_PLAYER;
    this.tank = tank;
  }
}

module.exports = { Cell };
