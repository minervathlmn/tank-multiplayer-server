// app.config.js
const { matchMaker } = require("colyseus");
const { TankRoom } = require("./rooms/TankRoom");

module.exports = {
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
    // Basic CORS so your GitHub Pages origin (and localhost during dev)
    // can connect. A literal wildcard "*" is NOT allowed here once
    // requests include credentials (client.http does this by default) —
    // browsers reject that combination outright. Echoing back the actual
    // requesting origin is the standard fix and still works for multiple
    // origins (localhost + your real domain) without hardcoding one.
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin) {
        res.header("Access-Control-Allow-Origin", origin);
      }
      res.header("Access-Control-Allow-Credentials", "true");
      res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
      next();
    });

    app.get("/", (req, res) => {
      res.send("Tank multiplayer server is running.");
    });

    // Simple health check endpoint — also useful for pinging the server
    // awake if you want to fight Render's free-tier cold starts later.
    app.get("/healthz", (req, res) => res.sendStatus(200));

    // Colyseus 0.16 removed client.getAvailableRooms() from the SDK
    // (exposing the full room list to any client was a security risk).
    // This route replaces it: the lobby client calls
    // client.http.get("/rooms/tank_room") instead, and we control
    // exactly what gets returned. `locked` excludes full rooms.
    app.get("/rooms/:roomName?", async (req, res) => {
      const conditions = { locked: false };
      if (req.params.roomName) conditions.name = req.params.roomName;

      try {
        const rooms = await matchMaker.query(conditions);
        res.json(rooms);
      } catch (err) {
        console.error("Room listing failed:", err);
        res.status(500).json({ error: "Failed to list rooms" });
      }
    });
  },

  beforeListen: () => {},
};