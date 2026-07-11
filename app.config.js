// app.config.js
const { defineConfig } = require("@colyseus/tools");
const { TankRoom } = require("./rooms/TankRoom");

module.exports = defineConfig({
  options: {
    devMode: false,
  },

  initializeGameServer: (gameServer) => {
    // "tank_room" is the room *type name* clients ask for.
    // maxClients: 4 matches your existing 4-player local game.
    gameServer.define("tank_room", TankRoom).filterBy(["isPrivate"]);
    // filterBy(["isPrivate"]) lets Colyseus separate public rooms
    // (isPrivate: false) from private ones when clients call
    // getAvailableRooms() — private rooms just won't show up in that list.
  },

  initializeExpress: (app) => {
    // Basic CORS so your GitHub Pages origin can connect.
    // Lock this down to your actual domain once it's working.
    app.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
      next();
    });

    app.get("/", (req, res) => {
      res.send("Tank multiplayer server is running.");
    });

    // Simple health check endpoint — also useful for pinging the server
    // awake if you want to fight Render's free-tier cold starts later.
    app.get("/healthz", (req, res) => res.sendStatus(200));
  },

  beforeListen: () => {},
});
