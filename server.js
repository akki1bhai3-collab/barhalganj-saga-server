// Barhalganj Saga — Multiplayer Server (Phase 2)
// Real-time player position/action sync over Socket.io

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;

// in-memory player state — fine for V1 (no persistence needed yet)
const players = {}; // socketId -> { id, name, color, x, y, z, rotY, level }

app.get("/", (req, res) => {
  res.send(
    `Barhalganj Saga multiplayer server is running. Players online: ${Object.keys(players).length}`
  );
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", playersOnline: Object.keys(players).length });
});

io.on("connection", (socket) => {
  console.log(`[connect] ${socket.id}`);

  // client sends this right after connecting
  socket.on("join", (data) => {
    players[socket.id] = {
      id: socket.id,
      name: (data && data.name) || `Traveler${socket.id.slice(0, 4)}`,
      color: (data && data.color) || 0x3fb6e0,
      x: (data && data.x) || 0,
      y: 0,
      z: (data && data.z) || 0,
      rotY: 0,
      level: (data && data.level) || 1
    };

    // send the new player the current roster
    socket.emit("currentPlayers", players);

    // tell everyone else this player joined
    socket.broadcast.emit("playerJoined", players[socket.id]);
  });

  // frequent position/rotation updates
  socket.on("move", (data) => {
    const p = players[socket.id];
    if (!p) return;
    p.x = data.x;
    p.y = data.y || 0;
    p.z = data.z;
    p.rotY = data.rotY;
    socket.broadcast.emit("playerMoved", {
      id: socket.id,
      x: p.x,
      y: p.y,
      z: p.z,
      rotY: p.rotY
    });
  });

  // attack / skill animation broadcast (visual only, each client resolves its own combat locally for now)
  socket.on("action", (data) => {
    socket.broadcast.emit("playerAction", { id: socket.id, type: data.type });
  });

  // simple chat
  socket.on("chat", (data) => {
    const p = players[socket.id];
    const name = p ? p.name : "Unknown";
    io.emit("chatMessage", { name, text: String(data.text || "").slice(0, 200) });
  });

  socket.on("disconnect", () => {
    console.log(`[disconnect] ${socket.id}`);
    delete players[socket.id];
    io.emit("playerLeft", { id: socket.id });
  });
});

server.listen(PORT, () => {
  console.log(`Barhalganj Saga multiplayer server listening on port ${PORT}`);
});
