# Tank Multiplayer Server

Lobby + turn-relay server for the Tanks game, built with [Colyseus](https://colyseus.io/).
Deploy this repo separately from your GitHub Pages portfolio — this needs a
persistent Node process, which GitHub Pages can't run.

## Local test

```bash
npm install
npm run dev
```

Server starts on `http://localhost:2567`. Colyseus also gives you a free
dev inspector at `http://localhost:2567/colyseus` — handy for watching
room state live while you build the client.

## Deploy to Render

1. Push this folder as its own GitHub repo (e.g. `tank-multiplayer-server`).
2. On Render: **New +** → **Web Service** → connect that repo.
3. Settings:
   - Language: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Root Directory: leave blank
4. Deploy. You'll get a URL like `tank-game-server.onrender.com`.
5. Note: Render's free tier sleeps after 15 min idle — first connect after
   sleeping takes ~30-50s. Show a "connecting to server..." state in your
   lobby UI so it doesn't look broken.

## Client integration (matches your wireframes)

Install the Colyseus JS client in your game's frontend:
```html
<script src="https://unpkg.com/colyseus.js@^0.15.0/dist/colyseus.js"></script>
```

```js
const client = new Colyseus.Client("wss://tank-game-server.onrender.com");

// --- "Quick Join" button ---
async function quickJoin(nickname) {
  const room = await client.joinOrCreate("tank_room", {
    nickname,
    isPrivate: false,
  });
  enterLobby(room);
}

// --- "Create Lobby" -> public/private choice ---
async function createLobby(nickname, isPrivate) {
  const room = await client.create("tank_room", { nickname, isPrivate });
  enterLobby(room);
  if (isPrivate) showCode(room.id); // room.id is your "Code:" shown in pic 4
}

// --- "Join Others" -> enter code ---
async function joinByCode(nickname, code) {
  const room = await client.joinById(code, { nickname });
  enterLobby(room);
}

// --- "Join Others" -> public lobby list ---
async function listPublicLobbies() {
  const rooms = await client.getAvailableRooms("tank_room");
  return rooms.filter((r) => r.metadata?.isPrivate === false);
  // each entry has r.metadata.ownerNickname, r.metadata.playerCount, r.roomId
}

// --- shared lobby wiring ---
function enterLobby(room) {
  room.state.players.onAdd((player, sessionId) => {
    // render player row, e.g. "[Player's Nickname]" boxes in pic 4
  });
  room.state.players.onRemove((player, sessionId) => {
    // remove player row
  });
  room.state.listen("started", (started) => {
    if (started) hideLobbyShowGame();
  });
  room.onMessage("shotFired", ({ sessionId, angle, power }) => {
    // feed into your existing Tank.js / GameLogic.js to replay the shot
    // for whichever player sessionId fired
  });

  window.currentRoom = room; // wherever you keep it
}

// owner-only
function readyUp(room, isReady) {
  room.send("ready", isReady);
}
function startGame(room) {
  room.send("start");
}

// during a player's own turn
function fireShot(room, angle, power) {
  room.send("fire", { angle, power });
}
```

## What's still on you

- The actual tank physics/rendering stays entirely in your existing
  `Tank.js` / `GameLogic.js` — this server never touches pixels, it just
  tells every client "player X fired at angle Y, power Z" and lets each
  client's own simulation play that out identically.
- Make sure your projectile physics is deterministic (no unseeded
  `Math.random()`, fixed timestep) so all 4 clients render the same
  outcome from the same fire message.
- Reconnect handling (someone's wifi drops mid-game) isn't in this
  scaffold — Colyseus supports `allowReconnection()` if you want to add it later.
