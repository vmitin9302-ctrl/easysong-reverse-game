# Initial MVP QA

Automated gate:

- TypeScript typecheck.
- Audio-engine unit tests.
- Web smoke tests.
- Production web build.
- Python dependency installation.
- Python compile check for API and Telegram bot.
- `node ops/qa-production-duel.mjs` for a bounded production smoke test of both rounds, private audio transfer/deletion, cancellation and forfeit.

Manual device QA before public launch:

- Chrome Android: microphone permission, two recordings, playback, result.
- Safari iOS: MediaRecorder MIME fallback and AudioContext resume after user gesture.
- Telegram Android/iOS: viewport, microphone permission and Mini App bridge.
- Desktop Chrome/Edge/Safari/Firefox.
- EasySong redirect with API online and API unavailable.
- Referral link `?ref=...`.

Audio acceptance:

- silence and very short clips are rejected;
- reverse twice restores the sample order;
- identical meaningful signals score near the top;
- obviously different signals score lower;
- local mode sends no audio Blob or PCM to backend endpoints;
- cross-device uploads only reversed challenge and responder attempt through signed URLs; verify original is never uploaded;
- two browsers complete round 1, swap roles, complete round 2, see the same scores/winner;
- expired signed URLs fail, scored-round object keys are cleared, and bucket lifecycle is enabled;
- closing the challenger's tab before scoring produces a clear privacy-related recovery error (the original deliberately is not recoverable from the server);
- final screen contains rematch, sharing, and the required EasySong marketing copy/CTA.

Cross-device state acceptance:

- while player 1 is recording, reviewing, replaying or uploading a challenge, polling an older `awaiting_challenge` snapshot must not return the UI to microphone permission;
- while player 2 is preparing, recording or uploading an attempt, polling `awaiting_attempt` must not return the UI to the listen screen;
- a challenge is downloaded once per round and stays playable until the attempt is submitted;
- scoring starts once even when several polling ticks observe `awaiting_score`;
- after refresh, the saved player token is available to the first audio download before React state finishes rendering;
- returning from the system share sheet or a backgrounded mobile browser triggers an immediate match refresh;
- cancel and forfeit are serialized against join/another forfeit, and a terminal state always overrides a locally locked audio step.
