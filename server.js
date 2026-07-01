// Barhalganj Saga — Multiplayer Server (Phase 2 + Phase 6 AI NPCs)
// Real-time player position/action sync over Socket.io
// Phase 6: server-side AI NPC chat using Google's Gemini API (free tier, no card needed)
// The API key never touches the client — it stays here on the server.

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

/* ============================================================
   PHASE 6 — AI NPC PERSONAS
============================================================ */
const NPC_PERSONAS = {
  panditGovind: {
    name: "Pandit Govind",
    system: "Tum Pandit Govind ho, Barhalganj Saga naam ke ek fantasy game ki duniya mein ek bade mandir ke pujari. Tum gyaani aur shaant ho, purani kahaniyan aur rakshason (bosses) ke baare mein purani jaankari rakhte ho. Hinglish mein baat karo (Hindi+English mix). Jawab bahut chhote rakho — sirf 1-2 line, kyunki ye ek game dialogue box hai, chatbot nahi. Rakshason ko haraane ke seedhe tarike kabhi mat batao, sirf cryptic hints do agar koi puchhe. Tum kabhi yeh mat kaho ki tum AI ho — hamesha apne fantasy character mein hi raho. Hamesha family-friendly raho."
  },
  buzurgDadi: {
    name: "Buzurg Dadi",
    system: "Tum Buzurg Dadi ho, Barhalganj Saga naam ke fantasy game mein ek budhi, pyaari dadi jo shehar mein rehti hai. Tumhe purani kahaniyan, dakiyanusi baatein, aur jungle ke raaz pata hain. Hinglish mein, dadi jaisi pyaar bhari tone mein baat karo. Jawab chhote rakho — sirf 1-2 line. Cryptic hints de sakti ho lekin seedha jawab kabhi mat do. Tum kabhi yeh mat kaho ki tum AI ho — hamesha apne character mein raho. Hamesha family-friendly raho."
  }
};

const chatHistory = {};      // `${socketId}:${npcId}` -> [{role,content}, ...]
const lastChatTime = {};     // socketId -> timestamp ms
const CHAT_COOLDOWN_MS = 3500;
const MAX_HISTORY_MSGS = 6;  // 3 exchanges of context
const GEMINI_MODEL = "gemini-2.5-flash";

async function callGemini(systemPrompt, history, userMessage) {
  const contents = history.map((h) => ({
    role: h.role === "assistant" ? "model" : "user",
    parts: [{ text: h.content }]
  }));
  contents.push({ role: "user", parts: [{ text: userMessage }] });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: {
          maxOutputTokens: 200,
          thinkingConfig: { thinkingBudget: 0 }
        }
      })
    }
  );
  const data = await res.json();
  const text =
    data &&
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts &&
    data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text;
  if (text) return text.trim();
  throw new Error((data && data.error && data.error.message) || "AI request failed");
}

app.get("/", (req, res) => {
  res.send(
    `Barhalganj Saga multiplayer server is running. Players online: ${Object.keys(players).length}`
  );
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", playersOnline: Object.keys(players).length });
});

const parties = {};     // partyId -> { members: { socketId -> {name, level, hp, maxHp} }, leaderId }
const playerParty = {}; // socketId -> partyId

function getPartyId(){ return "party_" + Date.now() + "_" + Math.random().toString(36).slice(2,6); }
function broadcastPartyUpdate(partyId){
  const party = parties[partyId];
  if(!party) return;
  Object.keys(party.members).forEach(sid=>{
    const s = io.sockets.sockets.get(sid);
    if(s) s.emit("party_update", { partyId, members: party.members });
  });
}

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

  // Phase 6 — AI-powered NPC conversation
  socket.on("npc_chat", async (data) => {
    const npcId = data && data.npcId;
    const persona = NPC_PERSONAS[npcId];
    if (!persona) return;

    const now = Date.now();
    if (lastChatTime[socket.id] && now - lastChatTime[socket.id] < CHAT_COOLDOWN_MS) {
      socket.emit("npc_chat_reply", { npcId, reply: null, error: "cooldown" });
      return;
    }
    lastChatTime[socket.id] = now;

    const userMessage = String((data && data.message) || "").slice(0, 200).trim();
    if (!userMessage) return;

    if (!process.env.GEMINI_API_KEY) {
      socket.emit("npc_chat_reply", { npcId, reply: null, error: "no_api_key" });
      return;
    }

    const key = `${socket.id}:${npcId}`;
    const history = chatHistory[key] || [];

    try {
      const reply = await callGemini(persona.system, history, userMessage);
      history.push({ role: "user", content: userMessage });
      history.push({ role: "assistant", content: reply });
      while (history.length > MAX_HISTORY_MSGS) history.shift();
      chatHistory[key] = history;
      socket.emit("npc_chat_reply", { npcId, reply });
    } catch (err) {
      console.error("npc_chat error:", err.message);
      socket.emit("npc_chat_reply", { npcId, reply: null, error: "api_error" });
    }
  });

  // Party system
  socket.on("party_invite", (data) => {
    const targetSocket = io.sockets.sockets.get(data.targetId);
    if(!targetSocket) return;
    // create a pending party id
    const pid = getPartyId();
    targetSocket.emit("party_invite", { partyId: pid, fromName: data.fromName, fromId: socket.id });
  });

  socket.on("party_accept", (data) => {
    const pid = data.partyId;
    if(!parties[pid]){
      parties[pid] = { members: {}, leaderId: socket.id };
    }
    const p = players[socket.id];
    parties[pid].members[socket.id] = { name: p?.name||"Yatri", level: p?.level||1, hp: 100, maxHp: 100 };
    playerParty[socket.id] = pid;
    broadcastPartyUpdate(pid);
  });

  socket.on("party_leave", () => {
    const pid = playerParty[socket.id];
    if(!pid || !parties[pid]) return;
    delete parties[pid].members[socket.id];
    delete playerParty[socket.id];
    socket.emit("party_left");
    if(Object.keys(parties[pid].members).length === 0) delete parties[pid];
    else broadcastPartyUpdate(pid);
  });

  socket.on("player_hp", (data) => {
    const pid = playerParty[socket.id];
    if(!pid || !parties[pid]) return;
    if(parties[pid].members[socket.id]){
      parties[pid].members[socket.id].hp = data.hp;
      parties[pid].members[socket.id].maxHp = data.maxHp;
    }
    // broadcast to other party members
    Object.keys(parties[pid].members).forEach(sid=>{
      if(sid!==socket.id){
        const s=io.sockets.sockets.get(sid);
        if(s) s.emit("player_hp_update",{id:socket.id,hp:data.hp,maxHp:data.maxHp});
      }
    });
  });

  socket.on("disconnect", () => {
    console.log(`[disconnect] ${socket.id}`);
    delete players[socket.id];
    delete lastChatTime[socket.id];
    Object.keys(chatHistory).forEach((k) => {
      if (k.startsWith(`${socket.id}:`)) delete chatHistory[k];
    });
    // cleanup party
    const pid = playerParty[socket.id];
    if(pid && parties[pid]){
      delete parties[pid].members[socket.id];
      delete playerParty[socket.id];
      if(Object.keys(parties[pid].members).length===0) delete parties[pid];
      else broadcastPartyUpdate(pid);
    }
    io.emit("playerLeft", { id: socket.id });
  });
});

server.listen(PORT, () => {
  console.log(`Barhalganj Saga multiplayer server listening on port ${PORT}`);
});
