
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { spawn } = require("child_process");

// Use ffmpeg-static when installed; otherwise try the system FFmpeg.
let ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";

try {
  const staticFFmpeg = require("ffmpeg-static");
  if (staticFFmpeg) ffmpegPath = staticFFmpeg;
} catch {
  console.warn("ffmpeg-static not installed; using system FFmpeg.");
}

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 4e6
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    app: "RoyMeet",
    ffmpegConfigured: true
  });
});

const hosts = new Map();
const broadcasts = new Map();
const hostMuted = new Set();

const streamingBase = {
  youtube:
    process.env.YOUTUBE_RTMP_BASE ||
    "rtmp://a.rtmp.youtube.com/live2/",

  facebook:
    process.env.FACEBOOK_RTMP_BASE ||
    "rtmps://live-api-s.facebook.com:443/rtmp/"
};

function emitParticipants(roomId) {
  const ids = [
    ...(io.sockets.adapter.rooms.get(roomId) || [])
  ];

  const participants = ids.map(id => ({
    id,
    name:
      io.sockets.sockets.get(id)?.data.name ||
      "Participant",
    host: hosts.get(roomId) === id,
    mutedByHost: hostMuted.has(id)
  }));

  io.to(roomId).emit("participant-list", participants);
}

function stopBroadcast(roomId, message = "Broadcast stopped") {
  const broadcast = broadcasts.get(roomId);

  if (!broadcast) return;

  // Delete first so intentional process exits aren't treated as errors.
  broadcasts.delete(roomId);

  for (const proc of broadcast.processes) {
    try {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.end();
      }

      if (!proc.killed) {
        proc.kill("SIGTERM");
      }
    } catch (error) {
      console.error("Error stopping FFmpeg:", error.message);
    }
  }

  io.to(roomId).emit("broadcast-status", {
    live: false,
    message
  });
}

io.on("connection", socket => {

  // JOIN MEETING
  socket.on("join-room", ({ roomId, name } = {}) => {
    roomId = String(roomId || "")
      .trim()
      .toUpperCase()
      .slice(0, 32);

    name = String(name || "")
      .trim()
      .slice(0, 40);

    if (!roomId || !name) {
      socket.emit(
        "room-error",
        "Enter your name and a valid meeting ID."
      );
      return;
    }

    if (socket.data.roomId) {
      socket.leave(socket.data.roomId);
    }

    const room = io.sockets.adapter.rooms.get(roomId);
    const existingUsers = room ? [...room] : [];

    socket.join(roomId);

    if (
      !hosts.has(roomId) ||
      !io.sockets.sockets.has(hosts.get(roomId))
    ) {
      hosts.set(roomId, socket.id);
    }

    socket.data.roomId = roomId;
    socket.data.name = name;

    socket.emit("room-role", {
      host: hosts.get(roomId) === socket.id
    });

    socket.emit("host-mute-state", {
      muted: hostMuted.has(socket.id)
    });

    if (broadcasts.has(roomId)) {
      socket.emit("broadcast-status", {
        live: true,
        message: "Meeting is being livestreamed"
      });
    }

    socket.emit(
      "existing-users",
      existingUsers.map(id => ({
        id,
        name:
          io.sockets.sockets.get(id)?.data.name ||
          "Participant"
      }))
    );

    socket.to(roomId).emit("user-joined", {
      id: socket.id,
      name
    });

    emitParticipants(roomId);
  });

  // HOST MUTE / UNMUTE PARTICIPANT
  socket.on(
    "host-mute-participant",
    ({ targetId, muted } = {}) => {
      const roomId = socket.data.roomId;

      if (
        !roomId ||
        hosts.get(roomId) !== socket.id ||
        !targetId ||
        targetId === socket.id
      ) return;

      const target = io.sockets.sockets.get(targetId);

      if (!target || target.data.roomId !== roomId) return;

      if (muted) {
        hostMuted.add(targetId);
      } else {
        hostMuted.delete(targetId);
      }

      target.emit("host-mute-state", {
        muted: !!muted
      });

      emitParticipants(roomId);
    }
  );

  // HOST REMOVE PARTICIPANT
  socket.on(
    "host-remove-participant",
    ({ targetId } = {}) => {
      const roomId = socket.data.roomId;

      if (
        !roomId ||
        hosts.get(roomId) !== socket.id ||
        !targetId ||
        targetId === socket.id
      ) return;

      const target = io.sockets.sockets.get(targetId);

      if (!target || target.data.roomId !== roomId) return;

      target.emit("removed-from-meeting", {
        message:
          "The host removed you from this meeting."
      });

      hostMuted.delete(targetId);
      target.disconnect(true);

      emitParticipants(roomId);
    }
  );

  // WEBRTC SIGNALLING
  socket.on("offer", ({ to, offer } = {}) => {
    if (to && offer) {
      io.to(to).emit("offer", {
        from: socket.id,
        offer,
        name: socket.data.name || "Participant"
      });
    }
  });

  socket.on("answer", ({ to, answer } = {}) => {
    if (to && answer) {
      io.to(to).emit("answer", {
        from: socket.id,
        answer
      });
    }
  });

  socket.on(
    "ice-candidate",
    ({ to, candidate } = {}) => {
      if (to && candidate) {
        io.to(to).emit("ice-candidate", {
          from: socket.id,
          candidate
        });
      }
    }
  );

  // MEETING CHAT
  socket.on("chat-message", ({ message } = {}) => {
    const roomId = socket.data.roomId;

    const clean = String(message || "")
      .trim()
      .slice(0, 1000);

    if (!roomId || !clean) return;

    io.to(roomId).emit("chat-message", {
      name: socket.data.name || "Participant",
      message: clean,
      time: new Date().toISOString()
    });
  });

  // START YOUTUBE / FACEBOOK / BOTH
  socket.on(
    "start-broadcast",
    ({ youtubeKey, facebookKey } = {}) => {

      const roomId = socket.data.roomId;

      // Only the meeting host can broadcast.
      if (!roomId || hosts.get(roomId) !== socket.id) {
        socket.emit(
          "broadcast-error",
          "Only the meeting host can start broadcasting."
        );
        return;
      }

      if (broadcasts.has(roomId)) {
        socket.emit(
          "broadcast-error",
          "A broadcast is already running."
        );
        return;
      }

      const destinations = [
        {
          platform: "youtube",
          key: String(youtubeKey || "").trim()
        },
        {
          platform: "facebook",
          key: String(facebookKey || "").trim()
        }
      ].filter(item => item.key);

      if (!destinations.length) {
        socket.emit(
          "broadcast-error",
          "Enter a YouTube or Facebook stream key."
        );
        return;
      }

      if (
        destinations.some(
          item =>
            item.key.length > 256 ||
            /[\s\r\n]/.test(item.key)
        )
      ) {
        socket.emit(
          "broadcast-error",
          "Invalid stream key. Please check it."
        );
        return;
      }

      const processes = [];

      try {
        for (const destination of destinations) {

          const base = streamingBase[destination.platform];

          if (!base || !/^rtmps?:\/\//i.test(base)) {
            throw new Error(
              `Invalid ${destination.platform} streaming endpoint`
            );
          }

          const outputUrl = base + destination.key;

          console.log(
            `Starting ${destination.platform} encoder`
          );

          const proc = spawn(
            ffmpegPath,
            [
              "-hide_banner",
              "-loglevel", "warning",
              "-nostats",
              "-fflags", "+genpts",

              "-f", "webm",
              "-i", "pipe:0",

              "-map", "0:v:0",
              "-map", "0:a?",

              "-c:v", "libx264",
              "-preset", "veryfast",
              "-tune", "zerolatency",
              "-pix_fmt", "yuv420p",
              "-r", "15",
              "-g", "30",
              "-b:v", "1600k",
              "-maxrate", "1800k",
              "-bufsize", "3200k",

              "-c:a", "aac",
              "-b:a", "128k",
              "-ar", "44100",

              "-f", "flv",
              outputUrl
            ],
            {
              stdio: ["pipe", "ignore", "pipe"]
            }
          );

          // Log useful FFmpeg errors, but never expose stream keys.
          proc.stderr.on("data", data => {
            let message = data.toString();

            message = message.replaceAll(
              destination.key,
              "[STREAM_KEY_REDACTED]"
            );

            message = message.replace(
              /rtmps?:\/\/[^\s]+/gi,
              "[STREAM_URL_REDACTED]"
            );

            if (message.trim()) {
              console.error(
                `[FFmpeg ${destination.platform}]`,
                message.trim()
              );
            }
          });

          proc.stdin.on("error", error => {
            console.error(
              `[FFmpeg ${destination.platform}] input error:`,
              error.message
            );
          });

          proc.on("error", error => {
            console.error(
              `[FFmpeg ${destination.platform}] process error:`,
              error.message
            );

            if (broadcasts.has(roomId)) {
              stopBroadcast(
                roomId,
                "FFmpeg failed to start. Check installation."
              );
            }
          });

          proc.on("exit", (code, signal) => {
            console.error(
              `[FFmpeg ${destination.platform}] exited`,
              { code, signal }
            );

            if (broadcasts.has(roomId)) {
              stopBroadcast(
                roomId,
                "Broadcast encoder exited. Check Render logs."
              );
            }
          });

          processes.push(proc);
        }

        const platforms = destinations.map(item =>
          item.platform === "youtube"
            ? "YouTube"
            : "Facebook"
        );

        broadcasts.set(roomId, {
          owner: socket.id,
          processes,
          platforms
        });

        io.to(roomId).emit("broadcast-status", {
          live: true,
          message:
            `Broadcast starting: ${platforms.join(" + ")}`
        });

        console.log(
          `Broadcast processes started for ${platforms.join(" + ")}`
        );

      } catch (error) {
        console.error(
          "Broadcast startup error:",
          error.message
        );

        for (const proc of processes) {
          try {
            proc.kill("SIGTERM");
          } catch {}
        }

        socket.emit(
          "broadcast-error",
          "Could not start FFmpeg. Check its installation and server configuration."
        );
      }
    }
  );

  // RECEIVE MEDIARECORDER WEBM CHUNKS
  socket.on("broadcast-chunk", data => {
    const roomId = socket.data.roomId;
    const broadcast = broadcasts.get(roomId);

    if (
      !broadcast ||
      broadcast.owner !== socket.id ||
      !Buffer.isBuffer(data) ||
      data.length > 3e6
    ) return;

    for (const proc of broadcast.processes) {
      if (
        proc.stdin &&
        proc.stdin.writable &&
        !proc.stdin.destroyed &&
        proc.stdin.writableLength < 8e6
      ) {
        proc.stdin.write(data);
      }
    }
  });

  // STOP BROADCAST
  socket.on("stop-broadcast", () => {
    const roomId = socket.data.roomId;

    if (
      roomId &&
      hosts.get(roomId) === socket.id
    ) {
      stopBroadcast(roomId);
    }
  });

  // CLEANUP AND HOST TRANSFER
  socket.on("disconnecting", () => {
    const roomId = socket.data.roomId;

    if (!roomId) return;

    if (hosts.get(roomId) === socket.id) {
      stopBroadcast(
        roomId,
        "Host left; broadcast stopped."
      );

      hosts.delete(roomId);

      const others = [
        ...(io.sockets.adapter.rooms.get(roomId) || [])
      ].filter(id => id !== socket.id);

      if (others.length) {
        hosts.set(roomId, others[0]);

        io.to(others[0]).emit("room-role", {
          host: true
        });
      }
    }

    hostMuted.delete(socket.id);
    socket.to(roomId).emit("user-left", {
      id: socket.id
    });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;

    if (roomId) {
      emitParticipants(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`RoyMeet running on port ${PORT}`);
  console.log(`FFmpeg executable configured: ${ffmpegPath}`);
});
