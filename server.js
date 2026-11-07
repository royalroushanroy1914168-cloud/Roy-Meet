const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] },
  maxHttpBufferSize: 4e6
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, app: "RoyMeet" }));

// Stream keys are kept only in memory while streaming. Do not log them.
const hosts = new Map();
const broadcasts = new Map();
const hostMuted = new Set();

function emitParticipants(roomId) {
  const ids = [...(io.sockets.adapter.rooms.get(roomId) || [])];
  const participants = ids.map(id => ({
    id,
    name: io.sockets.sockets.get(id)?.data.name || "Participant",
    host: hosts.get(roomId) === id,
    mutedByHost: hostMuted.has(id)
  }));
  io.to(roomId).emit("participant-list", participants);
}
const streamingBase = {
  youtube: process.env.YOUTUBE_RTMP_BASE || "rtmp://a.rtmp.youtube.com/live2/",
  facebook: process.env.FACEBOOK_RTMP_BASE || "rtmps://live-api-s.facebook.com:443/rtmp/"
};

function stopBroadcast(roomId, message = "Broadcast stopped") {
  const broadcast = broadcasts.get(roomId);
  if (!broadcast) return;
  broadcasts.delete(roomId);
  for (const proc of broadcast.processes) {
    try { proc.stdin.end(); } catch {}
    setTimeout(() => { if (!proc.killed) proc.kill("SIGTERM"); }, 2000).unref();
  }
  io.to(roomId).emit("broadcast-status", { live: false, message });
}

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, name } = {}) => {
    roomId = String(roomId || "").trim().toUpperCase().slice(0, 32);
    name = String(name || "").trim().slice(0, 40);
    if (!roomId || !name) {
      socket.emit("room-error", "Enter your name and a valid meeting ID.");
      return;
    }

    // A socket can belong to only one room in this starter app.
    if (socket.data.roomId) {
      socket.leave(socket.data.roomId);
    }

    const room = io.sockets.adapter.rooms.get(roomId);
    const existingUsers = room ? [...room] : [];
    socket.join(roomId);
    if (!hosts.has(roomId) || !io.sockets.sockets.has(hosts.get(roomId))) {
      hosts.set(roomId, socket.id);
    }
    socket.emit("room-role", { host: hosts.get(roomId) === socket.id });
    socket.emit("host-mute-state", { muted: hostMuted.has(socket.id) });
    if (broadcasts.has(roomId)) socket.emit("broadcast-status", { live: true, message: "Meeting is being livestreamed" });
    socket.data.roomId = roomId;
    socket.data.name = name;

    socket.emit("existing-users", existingUsers.map(id => ({
      id,
      name: io.sockets.sockets.get(id)?.data.name || "Participant"
    })));

    socket.to(roomId).emit("user-joined", { id: socket.id, name });
    emitParticipants(roomId);
  });

  socket.on("host-mute-participant", ({ targetId, muted } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId || hosts.get(roomId) !== socket.id || !targetId || targetId === socket.id) return;
    const target = io.sockets.sockets.get(targetId);
    if (!target || target.data.roomId !== roomId) return;
    if (muted) hostMuted.add(targetId);
    else hostMuted.delete(targetId);
    target.emit("host-mute-state", { muted: !!muted });
    emitParticipants(roomId);
  });

  socket.on("host-remove-participant", ({ targetId } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId || hosts.get(roomId) !== socket.id || !targetId || targetId === socket.id) return;
    const target = io.sockets.sockets.get(targetId);
    if (!target || target.data.roomId !== roomId) return;
    target.emit("removed-from-meeting", { message: "The host removed you from this meeting." });
    hostMuted.delete(targetId);
    target.disconnect(true);
    emitParticipants(roomId);
  });

  socket.on("offer", ({ to, offer } = {}) => {
    if (to && offer) io.to(to).emit("offer", {
      from: socket.id, offer, name: socket.data.name || "Participant"
    });
  });

  socket.on("answer", ({ to, answer } = {}) => {
    if (to && answer) io.to(to).emit("answer", { from: socket.id, answer });
  });

  socket.on("ice-candidate", ({ to, candidate } = {}) => {
    if (to && candidate) io.to(to).emit("ice-candidate", {
      from: socket.id, candidate
    });
  });

  socket.on("chat-message", ({ message } = {}) => {
    const roomId = socket.data.roomId;
    const clean = String(message || "").trim().slice(0, 1000);
    if (!roomId || !clean) return;
    io.to(roomId).emit("chat-message", {
      name: socket.data.name || "Participant",
      message: clean,
      time: new Date().toISOString()
    });
  });

  socket.on("start-broadcast", ({ youtubeKey, facebookKey } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId || hosts.get(roomId) !== socket.id) return;
    if (broadcasts.has(roomId)) return socket.emit("broadcast-error", "Broadcast is already running.");

    // Either destination may be used alone; supplying both starts both outputs.
    const destinations = [
      { platform: "youtube", key: String(youtubeKey || "").trim() },
      { platform: "facebook", key: String(facebookKey || "").trim() }
    ].filter(item => item.key);
    if (!destinations.length) {
      return socket.emit("broadcast-error", "Enter at least one stream key: YouTube, Facebook, or both.");
    }
    if (destinations.some(item => item.key.length > 256 || /[\s\r\n]/.test(item.key))) {
      return socket.emit("broadcast-error", "A stream key appears invalid. Check the key and try again.");
    }
    const processes = [];
    try {
      for (const destination of destinations) {
        const url = streamingBase[destination.platform] + destination.key;
        const proc = spawn("ffmpeg", [
          "-hide_banner", "-loglevel", "error", "-fflags", "+genpts",
          "-f", "webm", "-i", "pipe:0",
          "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
          "-pix_fmt", "yuv420p", "-r", "15", "-g", "30",
          "-b:v", "1600k", "-maxrate", "1800k", "-bufsize", "3200k",
          "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
          "-f", "flv", url
        ], { stdio: ["pipe", "ignore", "pipe"] });
        // Avoid logging FFmpeg output: it can contain sensitive RTMP URLs.
        proc.stderr.on("data", () => {});
        proc.stdin.on("error", () => {});
        proc.on("error", () => {
          if (broadcasts.has(roomId)) stopBroadcast(roomId, "FFmpeg failed. Check server installation and stream keys.");
        });
        proc.on("exit", (code) => {
          if (broadcasts.has(roomId)) stopBroadcast(roomId, "Broadcast encoder exited. Check platform stream settings.");
        });
        processes.push(proc);
      }
      const platforms = destinations.map(item => item.platform === "youtube" ? "YouTube" : "Facebook");
      broadcasts.set(roomId, { owner: socket.id, processes, platforms });
      io.to(roomId).emit("broadcast-status", { live: true, message: `Broadcasting to ${platforms.join(" + ")}` });
    } catch (error) {
      for (const proc of processes) proc.kill("SIGTERM");
      socket.emit("broadcast-error", "Could not start FFmpeg on this server.");
    }
  });

  socket.on("broadcast-chunk", (data) => {
    const roomId = socket.data.roomId;
    const broadcast = broadcasts.get(roomId);
    if (!broadcast || broadcast.owner !== socket.id || !Buffer.isBuffer(data) || data.length > 3e6) return;
    for (const proc of broadcast.processes) {
      if (proc.stdin.writable && proc.stdin.writableLength < 8e6) proc.stdin.write(data);
    }
  });

  socket.on("stop-broadcast", () => {
    const roomId = socket.data.roomId;
    if (roomId && hosts.get(roomId) === socket.id) stopBroadcast(roomId);
  });

  socket.on("disconnect", () => {
    if (socket.data.roomId) {
      const roomId = socket.data.roomId;
      if (hosts.get(roomId) === socket.id) {
        stopBroadcast(roomId, "Host left; broadcast stopped");
        hosts.delete(roomId);
        const others = [...(io.sockets.adapter.rooms.get(roomId) || [])].filter(id => id !== socket.id);
        if (others.length) {
          hosts.set(roomId, others[0]);
          io.to(others[0]).emit("room-role", { host: true });
          emitParticipants(roomId);
        } else {
          hosts.delete(roomId);
        }
      }
      hostMuted.delete(socket.id);
      socket.to(roomId).emit("user-left", { id: socket.id });
      emitParticipants(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
// Bind to all interfaces so other devices on the same network can reach the server.
server.listen(PORT, "0.0.0.0", () => {
  console.log(`RoyMeet running on port ${PORT}`);
});