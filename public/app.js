const socket = io();
const $ = (id) => document.getElementById(id);

const lobby = $("lobby");
const meeting = $("meeting");
const nameInput = $("display-name");
const roomInput = $("meeting-id");
const localVideo = $("local-video");
const videoGrid = $("video-grid");

const peers = new Map();
const pendingCandidates = new Map();

let localStream = null;
let screenStream = null;
let roomId = null;
let displayName = null;
let micEnabled = true;
let cameraEnabled = true;
let leaving = false;
let isHost = false;
let broadcastRecorder = null;
let broadcastStream = null;
let broadcastCanvas = null;
let broadcastAnimation = null;
let broadcastAudioContext = null;
let broadcastAudioSources = [];
let broadcastRequested = false;
let meetingRecorder = null;
let meetingRecordingChunks = [];
let recordingActive = false;
let mutedByHost = false;

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

function makeRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function setLobbyError(message) { $("lobby-error").textContent = message || ""; }
function setMeetingError(message) { $("meeting-error").textContent = message || ""; }

async function enterMeeting(requestedId) {
  displayName = nameInput.value.trim();
  roomId = String(requestedId || "").trim().toUpperCase();

  if (!displayName) return setLobbyError("Please enter your name.");
  if (!roomId) return setLobbyError("Please enter a meeting ID.");

  setLobbyError("");
  if (!navigator.mediaDevices?.getUserMedia) {
    return setLobbyError("Camera and microphone require HTTPS (or localhost). Open the deployed HTTPS meeting link.");
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true }
    });
  } catch (error) {
    console.error("Media permission error:", error);
    return setLobbyError("Cannot access camera/microphone. Allow permissions in your browser and check that no other app is using the camera.");
  }

  localVideo.srcObject = localStream;
  lobby.classList.add("hidden");
  meeting.classList.remove("hidden");
  $("current-room").textContent = roomId;
  $("room-label").textContent = `Meeting ${roomId}`;
  $("connection-status").textContent = "Connecting…";

  if (!socket.connected) socket.connect();
  socket.emit("join-room", { roomId, name: displayName });
}

$("create-btn").addEventListener("click", () => {
  const id = makeRoomId();
  roomInput.value = id;
  enterMeeting(id);
});
$("join-btn").addEventListener("click", () => enterMeeting(roomInput.value));

socket.on("connect", () => {
  if (roomId && localStream && !leaving) {
    socket.emit("join-room", { roomId, name: displayName });
  }
});
socket.on("room-role", ({ host }) => {
  isHost = !!host;
  $("host-panel").classList.toggle("hidden", !isHost);
});
socket.on("broadcast-status", ({ live, message }) => {
  $("live-indicator").classList.toggle("hidden", !live);
  $("start-live").disabled = live;
  $("stop-live").disabled = !live;
  $("connection-status").textContent = message;
  if (!live) stopLocalBroadcast();
});
socket.on("broadcast-error", (message) => {
  setMeetingError(message);
  stopLocalBroadcast();
});

socket.on("participant-list", (participants) => {
  if (!isHost) return;
  const list = $("participant-list");
  list.replaceChildren();
  participants.filter(p => !p.host).forEach(p => {
    const row = document.createElement("div");
    row.className = "participant-row";
    const name = document.createElement("span");
    name.textContent = p.name + (p.mutedByHost ? " (muted by host)" : "");
    const actions = document.createElement("div");
    actions.className = "participant-actions";
    const mute = document.createElement("button");
    mute.className = "secondary";
    mute.textContent = p.mutedByHost ? "Unmute" : "Mute";
    mute.addEventListener("click", () => {
      socket.emit("host-mute-participant", { targetId: p.id, muted: !p.mutedByHost });
    });
    const remove = document.createElement("button");
    remove.className = "danger";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      if (confirm("Remove " + p.name + " from this meeting?")) {
        socket.emit("host-remove-participant", { targetId: p.id });
      }
    });
    actions.append(mute, remove);
    row.append(name, actions);
    list.appendChild(row);
  });
  if (!list.children.length) list.textContent = "No other participants yet.";
});

socket.on("host-mute-state", ({ muted }) => {
  mutedByHost = !!muted;
  if (mutedByHost) {
    localStream?.getAudioTracks().forEach(track => track.enabled = false);
    micEnabled = false;
    $("mic-btn").textContent = "Muted by host";
    $("mic-btn").disabled = true;
  } else {
    $("mic-btn").disabled = false;
    $("mic-btn").textContent = micEnabled ? "Mute mic" : "Unmute mic";
  }
});

socket.on("removed-from-meeting", ({ message }) => {
  alert(message || "The host removed you from this meeting.");
  $("leave-btn").click();
});
socket.on("connect_error", (error) => {
  setMeetingError("Server connection failed: " + error.message);
});
socket.on("room-error", setLobbyError);

function createPeer(userId, name) {
  if (peers.has(userId)) return peers.get(userId);

  const tile = document.createElement("div");
  tile.className = "video-tile";
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  const label = document.createElement("span");
  label.className = "participant-name";
  label.textContent = name || "Participant";
  tile.append(video, label);
  videoGrid.appendChild(tile);

  const pc = new RTCPeerConnection(rtcConfig);
  const remoteStream = new MediaStream();
  video.srcObject = remoteStream;

  pc.ontrack = (event) => {
    const incoming = event.streams?.[0];
    if (incoming) {
      incoming.getTracks().forEach(track => {
        if (!remoteStream.getTracks().some(t => t.id === track.id)) {
          remoteStream.addTrack(track);
        }
      });
    } else if (!remoteStream.getTracks().some(t => t.id === event.track.id)) {
      remoteStream.addTrack(event.track);
    }
    video.play().catch(() => {});
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("ice-candidate", { to: userId, candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      $("connection-status").textContent = "Connected";
    } else if (["failed", "closed"].includes(pc.connectionState)) {
      removePeer(userId);
    }
  };

  // Add camera/microphone tracks before creating an offer.
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  const peer = { pc, tile, video, name };
  peers.set(userId, peer);
  return peer;
}

async function callUser(userId, name) {
  const peer = createPeer(userId, name);
  const offer = await peer.pc.createOffer();
  await peer.pc.setLocalDescription(offer);
  socket.emit("offer", { to: userId, offer: peer.pc.localDescription });
}

socket.on("existing-users", async users => {
  for (const user of users) {
    try { await callUser(user.id, user.name); }
    catch (error) { console.error("Could not call participant", error); }
  }
});

socket.on("user-joined", ({ id, name }) => {
  createPeer(id, name);
});

socket.on("offer", async ({ from, offer, name }) => {
  try {
    const peer = createPeer(from, name);
    await peer.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const queued = pendingCandidates.get(from) || [];
    for (const candidate of queued) await peer.pc.addIceCandidate(candidate);
    pendingCandidates.delete(from);

    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    socket.emit("answer", { to: from, answer: peer.pc.localDescription });
  } catch (error) {
    console.error("Offer handling failed:", error);
    setMeetingError("Could not connect to a participant. Try leaving and rejoining.");
  }
});

socket.on("answer", async ({ from, answer }) => {
  const peer = peers.get(from);
  if (!peer) return;
  try {
    await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
    const queued = pendingCandidates.get(from) || [];
    for (const candidate of queued) await peer.pc.addIceCandidate(candidate);
    pendingCandidates.delete(from);
  } catch (error) {
    console.error("Answer handling failed:", error);
  }
});

socket.on("ice-candidate", async ({ from, candidate }) => {
  const peer = peers.get(from);
  if (!peer || !candidate) return;
  const ice = new RTCIceCandidate(candidate);
  if (peer.pc.remoteDescription?.type) {
    try { await peer.pc.addIceCandidate(ice); }
    catch (error) { console.warn("ICE candidate error:", error); }
  } else {
    const queue = pendingCandidates.get(from) || [];
    queue.push(ice);
    pendingCandidates.set(from, queue);
  }
});

socket.on("user-left", ({ id }) => removePeer(id));

function removePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.pc.ontrack = null;
  peer.pc.close();
  peer.tile.remove();
  peers.delete(id);
  pendingCandidates.delete(id);
}

$("mic-btn").addEventListener("click", () => {
  if (mutedByHost) return;
  micEnabled = !micEnabled;
  localStream?.getAudioTracks().forEach(track => track.enabled = micEnabled);
  $("mic-btn").textContent = micEnabled ? "Mute mic" : "Unmute mic";
});

$("camera-btn").addEventListener("click", () => {
  cameraEnabled = !cameraEnabled;
  localStream?.getVideoTracks().forEach(track => track.enabled = cameraEnabled);
  $("camera-btn").textContent = cameraEnabled ? "Camera off" : "Camera on";
});

$("share-btn").addEventListener("click", async () => {
  try {
    if (screenStream) {
      await stopScreenShare();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("Screen sharing is not supported by this browser/device. Try desktop Chrome or Edge.");
    }

    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: false
    });
    const screenTrack = screenStream.getVideoTracks()[0];
    if (!screenTrack) throw new Error("No screen video track was selected.");

    localVideo.srcObject = screenStream;

    for (const { pc } of peers.values()) {
      let sender = pc.getSenders().find(s => s.track?.kind === "video");
      if (sender) {
        await sender.replaceTrack(screenTrack);
      } else {
        sender = pc.addTrack(screenTrack, screenStream);
      }
    }

    screenTrack.addEventListener("ended", () => {
      stopScreenShare().catch(console.error);
    }, { once: true });

    $("share-btn").textContent = "Stop sharing";
    setMeetingError("");
  } catch (error) {
    console.error("Screen share error:", error);
    setMeetingError("Screen share: " + (error.message || "Unable to share screen."));
    if (screenStream) await stopScreenShare();
  }
});

async function stopScreenShare() {
  if (!screenStream) return;
  const oldScreen = screenStream;
  screenStream = null;
  oldScreen.getTracks().forEach(track => track.stop());
  localVideo.srcObject = localStream;

  const cameraTrack = localStream?.getVideoTracks()[0];
  for (const { pc } of peers.values()) {
    const sender = pc.getSenders().find(s => s.track?.kind === "video");
    if (sender && cameraTrack) await sender.replaceTrack(cameraTrack);
  }
  $("share-btn").textContent = "Share screen";
}

$("copy-link").addEventListener("click", async () => {
  // This link uses the actual deployed host, not localhost in the copied text.
  const inviteUrl = new URL("/", window.location.href);
  inviteUrl.searchParams.set("room", roomId);
  try {
    await navigator.clipboard.writeText(inviteUrl.toString());
    $("copy-link").textContent = "Link copied!";
    setTimeout(() => $("copy-link").textContent = "Copy invite link", 1800);
  } catch {
    window.prompt("Copy this meeting invitation link:", inviteUrl.toString());
  }
});

$("chat-form").addEventListener("submit", event => {
  event.preventDefault();
  const input = $("chat-input");
  const message = input.value.trim();
  if (!message) return;
  socket.emit("chat-message", { message });
  input.value = "";
});

socket.on("chat-message", ({ name, message }) => {
  const item = document.createElement("div");
  item.className = "message";
  const author = document.createElement("strong");
  author.textContent = name;
  const body = document.createElement("span");
  body.textContent = message;
  item.append(author, body);
  $("messages").appendChild(item);
  $("messages").scrollTop = $("messages").scrollHeight;
});

// Capture the meeting gallery into a single video and mix participant audio.
// The host must obtain participant permission before starting a public broadcast.
async function buildBroadcastStream() {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas capture is unavailable.");
  broadcastCanvas = canvas;
  const render = () => {
    if (!broadcastCanvas) return;
    ctx.fillStyle = "#10131b";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const videos = [localVideo, ...[...peers.values()].map(p => p.video)]
      .filter(video => video.readyState >= 2 && video.videoWidth > 0);
    const count = Math.max(1, videos.length);
    const columns = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / columns);
    const cellW = canvas.width / columns;
    const cellH = canvas.height / rows;
    videos.forEach((video, index) => {
      const x = (index % columns) * cellW;
      const y = Math.floor(index / columns) * cellH;
      const ratio = Math.min(cellW / video.videoWidth, cellH / video.videoHeight);
      const w = video.videoWidth * ratio;
      const h = video.videoHeight * ratio;
      ctx.drawImage(video, x + (cellW - w) / 2, y + (cellH - h) / 2, w, h);
    });
    broadcastAnimation = requestAnimationFrame(render);
  };
  render();

  const videoStream = canvas.captureStream(15);
  const audioCtx = new AudioContext();
  broadcastAudioContext = audioCtx;
  await audioCtx.resume();
  const destination = audioCtx.createMediaStreamDestination();
  // Local and remote audio are mixed; rewire when participants join/leave.
  const connected = new Set();
  const wireAudio = () => {
    const streams = [localStream, ...[...peers.values()].map(p => p.video.srcObject)];
    for (const stream of streams) {
      if (!stream || !stream.getAudioTracks().length || connected.has(stream)) continue;
      try {
        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(destination);
        broadcastAudioSources.push(source);
        connected.add(stream);
      } catch (error) { console.warn("Could not mix a participant audio stream", error); }
    }
  };
  wireAudio();
  const audioInterval = setInterval(wireAudio, 1000);
  broadcastStream = new MediaStream([
    ...videoStream.getVideoTracks(), ...destination.stream.getAudioTracks()
  ]);
  broadcastStream._audioInterval = audioInterval;
  return broadcastStream;
}

function stopLocalBroadcast() {
  if (broadcastRecorder && broadcastRecorder.state !== "inactive") broadcastRecorder.stop();
  broadcastRecorder = null;
  broadcastRequested = false;
  if (broadcastAnimation) cancelAnimationFrame(broadcastAnimation);
  broadcastAnimation = null;
  broadcastCanvas = null;
  if (broadcastStream && !recordingActive) {
    clearInterval(broadcastStream._audioInterval);
    broadcastStream.getTracks().forEach(track => track.stop());
    broadcastStream = null;
  }
  if (!recordingActive) {
    broadcastAudioSources.forEach(source => { try { source.disconnect(); } catch {} });
    broadcastAudioSources = [];
    if (broadcastAudioContext) broadcastAudioContext.close().catch(() => {});
    broadcastAudioContext = null;
  }
}

$("start-recording").addEventListener("click", async () => {
  if (!isHost || recordingActive) return;
  if (!confirm("Have all meeting participants agreed to be recorded? Recording is saved on this host's device.")) return;
  try {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
      throw new Error("Recording requires an updated desktop Chrome or Edge browser.");
    }
    const stream = broadcastStream || await buildBroadcastStream();
    const mimeType = ["video/webm;codecs=vp8,opus", "video/webm"]
      .find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("This browser cannot record WebM video.");
    meetingRecordingChunks = [];
    meetingRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1800000 });
    meetingRecorder.ondataavailable = event => {
      if (event.data && event.data.size) meetingRecordingChunks.push(event.data);
    };
    meetingRecorder.onerror = () => {
      $("recording-status").textContent = "Recording error. Try again.";
    };
    meetingRecorder.onstop = () => {
      const blob = new Blob(meetingRecordingChunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `RoyMeet-${roomId}-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      meetingRecordingChunks = [];
      $("recording-status").textContent = "Recording saved to your Downloads folder.";
    };
    meetingRecorder.start(1000);
    recordingActive = true;
    $("start-recording").disabled = true;
    $("stop-recording").disabled = false;
    $("recording-status").textContent = "● RECORDING — participants have been notified by the host.";
    ioRecordingNotice();
  } catch (error) {
    $("recording-status").textContent = "Recording: " + error.message;
    if (!broadcastRequested) stopLocalBroadcast();
  }
});

function ioRecordingNotice() {
  // The host must announce recording verbally or in meeting chat before starting.
  socket.emit("chat-message", { message: "The host has started recording this meeting. Please speak up if you do not consent." });
}

$("stop-recording").addEventListener("click", () => {
  if (!isHost || !meetingRecorder || meetingRecorder.state === "inactive") return;
  meetingRecorder.stop();
  recordingActive = false;
  $("start-recording").disabled = false;
  $("stop-recording").disabled = true;
  $("recording-status").textContent = "Preparing recording download…";
  if (!broadcastRequested) stopLocalBroadcast();
});

$("start-live").addEventListener("click", async () => {
  if (!isHost || broadcastRequested) return;
  const youtubeKey = $("youtube-key").value.trim();
  const facebookKey = $("facebook-key").value.trim();
  if (!youtubeKey && !facebookKey) {
    return setMeetingError("Enter a YouTube key, a Facebook key, or both.");
  }
  if (!confirm("Have all participants agreed to this public livestream? Press OK only after obtaining their consent.")) return;
  try {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
      throw new Error("Use an updated desktop Chrome or Edge browser to broadcast.");
    }
    const stream = broadcastStream || await buildBroadcastStream();
    const mimeType = ["video/webm;codecs=vp8,opus", "video/webm"]
      .find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("This browser cannot encode WebM video.");
    broadcastRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1600000 });
    broadcastRecorder.ondataavailable = async event => {
      if (event.data.size && socket.connected && broadcastRequested) {
        const bytes = await event.data.arrayBuffer();
        socket.emit("broadcast-chunk", bytes);
      }
    };
    broadcastRecorder.onerror = () => setMeetingError("Browser recording failed; stop and retry the broadcast.");
    broadcastRequested = true;
    // Start encoder first. Its status message is shown to all participants.
    socket.emit("start-broadcast", { youtubeKey, facebookKey });
    // Start sending media chunks after the server has received the start request.
    broadcastRecorder.start(1000);
    $("youtube-key").value = "";
    $("facebook-key").value = "";
    setMeetingError("");
  } catch (error) {
    stopLocalBroadcast();
    setMeetingError("Live broadcast: " + error.message);
  }
});

$("stop-live").addEventListener("click", () => {
  if (!isHost) return;
  stopLocalBroadcast();
  socket.emit("stop-broadcast");
});

$("leave-btn").addEventListener("click", async () => {
  if (meetingRecorder && meetingRecorder.state !== "inactive") meetingRecorder.stop();
  recordingActive = false;
  if (isHost) socket.emit("stop-broadcast");
  stopLocalBroadcast();
  leaving = true;
  if (screenStream) await stopScreenShare();
  for (const id of [...peers.keys()]) removePeer(id);
  localStream?.getTracks().forEach(track => track.stop());
  socket.disconnect();
  window.location.href = window.location.pathname;
});

// Pre-fill meeting ID when an invitation link contains ?room=XXXXXX.
const params = new URLSearchParams(window.location.search);
const invitedRoom = params.get("room");
if (invitedRoom) roomInput.value = invitedRoom.toUpperCase();
