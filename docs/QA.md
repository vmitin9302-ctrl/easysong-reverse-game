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

- Start screen: both «Вдвоём на одном устройстве» and «Вдвоём на разных устройствах» are visible and start independent flows.
- Chrome Android: microphone permission, two recordings, playback, result.
- Safari iOS: MediaRecorder MIME fallback and AudioContext resume after user gesture.
- Telegram Android/iOS: viewport, microphone permission and Mini App bridge.
- Desktop Chrome/Edge/Safari/Firefox.
- EasySong redirect with API online and API unavailable.
- Referral link `?ref=...`.

Audio acceptance:

- silence and very short clips are rejected;
- reverse twice restores the sample order;
- same-device mode completes two rounds with a device handoff between players, calculates both audio-similarity scores locally, and never calls room/audio API endpoints;
- same-device final screen plays the available original/attempt recordings and exits directly to the mode selector without a forced rematch;
- cross-device uploads only reversed challenge and responder attempt through signed URLs; verify original is never uploaded;
- the responder cannot read the secret phrase from match state before submitting a guess;
- exact guesses score 100 after case, punctuation, whitespace, and `ё`/`е` normalization;
- different guesses receive a lower deterministic text score;
- two browsers complete round 1, swap roles, complete round 2, see the same scores/winner;
- expired signed URLs fail, guessed-round object keys are cleared, and bucket lifecycle is enabled;
- refreshing the responder after uploading an attempt restores that attempt from temporary storage for normal playback and guessing;
- final screen lets either player exit independently, and contains sharing plus the required EasySong marketing copy/CTA.

Cross-device state acceptance:

- while player 1 is recording, reviewing, replaying or uploading a challenge, polling an older `awaiting_challenge` snapshot must not return the UI to microphone permission;
- while player 2 is preparing, recording or uploading an attempt, polling `awaiting_attempt` must not return the UI to the listen screen;
- a challenge is downloaded once per round and stays playable until the attempt is submitted;
- an attempt is downloaded once after refresh in `awaiting_guess`, reversed locally, and stays playable while the responder types;
- phrase and guess submission are authoritative, role-checked, and idempotent;
- after refresh, the saved player token is available to the first audio download before React state finishes rendering;
- returning from the system share sheet or a backgrounded mobile browser triggers an immediate match refresh;
- cancel and forfeit are serialized against join/another forfeit, and a terminal state always overrides a locally locked audio step.
- repeat join with the same participant token and confirm the same slot is returned; a third token must receive `409`;
- verify the permanent status bar changes between online, reconnecting and restored and that activity changes appear on the waiting device within roughly 1–2 seconds;
- retry identical phrase/upload/ready/guess calls and confirm no extra object or round transition is created.

Cross-platform matrix (run every row in both player-slot directions):

- Telegram Mini App creates → Chrome/Safari opens invite;
- Chrome/Safari creates → Telegram in-app browser opens invite;
- Telegram Mini App creates → another Telegram client opens invite;
- ordinary browser creates → another ordinary browser/device opens invite.

For every row verify live activity, 5-second heartbeat, 15-second reconnect indication, refresh/resume on both slots, identical player-mapped scores/winner, independent exit for either player after the terminal result, and the EasySong CTA only after that result. The room identity is the participant token and never depends on Telegram `initData`.

Infrastructure acceptance:

- API startup applies pending PostgreSQL migrations once under advisory lock;
- audio bucket remains private and exposes only signed object URLs;
- bucket CORS allows the production game origin to use `GET`, `PUT`, and `HEAD` with `Content-Type`;
- lifecycle removes any orphaned `matches/` object after one day, while normal guess/forfeit cleanup happens immediately;
- Yandex deploy workflow does not deploy a Telegram webhook/poller and reports Railway long polling in its summary.
