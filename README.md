# RoyMeet v1.3 — Recording and Host Controls

## Added in this version

- Host-only meeting recording: captures the meeting video gallery and mixed audio in the host's browser, then downloads a `.webm` file to the host's device.
- Host-only participant management panel.
- Host can mute or unmute an individual participant.
- Host can remove an individual participant from the room.
- Participants receive a visible recording announcement in meeting chat.
- Existing YouTube-only, Facebook-only, and dual-platform livestream options remain.

## Install / update

1. Stop the old server with `Ctrl + C`.
2. Extract this ZIP into a new folder.
3. Open the extracted `roymeet-live` folder in VS Code.
4. Run `npm install`.
5. Run `npm start`.
6. Open `http://localhost:3000`.

## Recording notes

- Recording is performed in the host's browser and saved locally as WebM.
- The host must obtain consent from all participants before recording.
- Recording captures the gallery composition and audio streams available to the host's browser. Large meetings may use significant CPU and memory.
- Recording is not cloud storage; if the host closes the browser before the file is finalized, the recording may be lost.

## Host controls notes

- The server checks that host-only mute/remove commands come from the current room host.
- Mute is implemented as a forced microphone-track disable in the participant's browser. This is suitable for a prototype, but a participant controlling a modified browser could bypass client-side enforcement. Production-grade moderation requires a media server (SFU) that can enforce track permissions.
- Host identity in this learning prototype is assigned to the first participant in a room and transferred when that host disconnects. It is not account-authenticated; do not use this as secure identity verification.

## Streaming notes

- Live streaming still requires FFmpeg on the server, valid platform stream keys, HTTPS for public deployment, and hosting that permits persistent FFmpeg processes and outbound RTMP/RTMPS.
- The browser sends the composed WebM stream to the server. End-to-end streaming should be tested with private/unlisted test broadcasts before public use.
- Never commit stream keys to source control or share them in screenshots.

## Important

This is a learning prototype, not a production Zoom replacement. Use HTTPS, authenticated accounts, a proper SFU/TURN architecture, server-side moderation, secure secret handling, recording consent workflows, and privacy controls before public launch.
