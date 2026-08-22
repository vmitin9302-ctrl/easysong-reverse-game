# Initial MVP QA

Automated gate:

- TypeScript typecheck.
- Audio-engine unit tests.
- Web smoke tests.
- Production web build.
- Python dependency installation.
- Python compile check for API and Telegram bot.

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
- no audio Blob or PCM is sent to backend endpoints.
