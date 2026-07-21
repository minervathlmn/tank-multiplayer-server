// index.js
//
// Entry point for the Tanks multiplayer server.
// Deployed on Render as a "Web Service". Your static game (GitHub Pages)
// connects to this over wss:// using the Colyseus client SDK. Depends on
// @colyseus/tools and app.config.

const { listen } = require("@colyseus/tools");
const config = require("./app.config");

// Render (and most hosts) inject PORT as an env var — always use it.
listen(config);