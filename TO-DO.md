DIRECTORY MAP:


[X]     ./scripts/sync-shared.js

[X]     ./levels/config.json
[X]     ./levels/level1.txt
[X]     ./levels/level2.txt
[X]     ./levels/level3.txt

[X]     ./shared/constants.js

[X]     ./rooms/logic/utils.js
[X]     ./rooms/logic/Rng.js
[X]     ./rooms/logic/Cell.js
[X]     ./rooms/logic/Board.js
[X]     ./rooms/logic/Explosion.js
[X]     ./rooms/logic/Projectile.js
[X]     ./rooms/logic/Tank.js
[X]     ./rooms/logic/GameLogic.js
[X]     ./rooms/logic/Bot.js

[X]     ./rooms/schema/TankState.js
[X]     ./rooms/schema/TankRoomState.js

[X]     ./rooms/TankRoom.js

[ ]     ./app.config.js       server/framework config, imports TankRoom.js
[ ]     ./index.js            entrypoint, imports app.config.js


  syncFullState() {
    ....
    for (const [letter, id] of this.letterToSession) {
      const tank = game.players.get(letter);
      const tankState = this.state.tanks.get(id);
      if (!tank || !tankState) continue;
      this.syncTankState(tank, tankState, game);

      const player = this.state.players.get(id);
      if (player) player.color = tank.colour.join(",");
    }
  }

  update(dt) {
    ....
    for (const [letter, id] of this.letterToSession) {
      const tank = game.players.get(letter);
      const tankState = this.state.tanks.get(id);
      if (!tank || !tankState) continue;
      this.syncTankState(tank, tankState, game);
    }
    ....
  }