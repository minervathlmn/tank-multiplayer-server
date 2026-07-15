// rooms/logic/Board.js
// Port of client Board.js — no p5 dependency existed in the original, so
// logic is unchanged. Only difference from the client version: Cell is
// require()'d here instead of assumed as a browser global.

const { Cell } = require('./Cell');

class Board {
  static CELLSIZE = 32;
  static WIDTH = 864;
  static HEIGHT = 640;
  static GRID_WIDTH = Math.floor(Board.WIDTH / Board.CELLSIZE) + 1; // 28
  static GRID_HEIGHT = 20;

  constructor() {
    this.cells = [];
    this.terrainPosition = new Array(Board.WIDTH + Board.CELLSIZE).fill(Board.HEIGHT);
    this.trees = [];
    this.playerStarts = [];
  }

  loadLayout(rawLines) {
    const lines = (rawLines ?? []).map(l => l.replace(/\r$/, ''));

    const padded = lines.map(line =>
      line.length < Board.GRID_WIDTH ? line + ' '.repeat(Board.GRID_WIDTH - line.length) : line
    );
    while (padded.length < Board.GRID_HEIGHT) {
      padded.push(' '.repeat(Board.GRID_WIDTH));
    }

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
          for (let j = 0; j < Board.CELLSIZE; j++) {
            const px = col * Board.CELLSIZE + j;
            if (px < this.terrainPosition.length) {
              this.terrainPosition[px] = row * Board.CELLSIZE;
            }
          }
        }
      }
      this.cells.push(cellRow);
    }

    this.smoothing();
    this.smoothing();

    this.trees = [];
    this.playerStarts = [];

    for (let row = 0; row < this.cells.length; row++) {
      for (let col = 0; col < this.cells[row].length; col++) {
        const cell = this.cells[row][col];

        if (cell.type === Cell.Type.TREE) {
          this.trees.push(col * Board.CELLSIZE);
        } else if (cell.type === Cell.Type.HUMAN_PLAYER) {
          const x = col * Board.CELLSIZE;
          const y = this.terrainPosition[x];
          this.playerStarts.push({ id: cell.id, x, y });
        }
      }
    }
  }

  smoothing() {
    for (let x = 0; x < this.terrainPosition.length - Board.CELLSIZE; x++) {
      let sum = 0;
      for (let c = 0; c < Board.CELLSIZE; c++) {
        sum += this.terrainPosition[x + c];
      }
      this.terrainPosition[x] = Math.floor(sum / Board.CELLSIZE);
    }
  }
}

module.exports = { Board };
