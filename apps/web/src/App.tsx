import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { prepareSignal, scoreSignals, type ScoreBreakdown } from '@reverse-game/audio-engine';
import { createDuelMatch, createGameSession, downloadRoundAudio, getDuelMatch, joinDuelMatch, submitRoundScore, trackEvent, uploadRoundAudio, type DuelMatch } from './api';
import { audioBufferToMono, audioBufferToWav, createAudioContext, decodeRecording, playAudioBuffer, reverseAudioBuffer, selectRecorderMimeType } from './audio/browserAudio';
import { initTelegram } from './telegram';
import './styles.css';

type Mode = 'local' | 'remote';
type Stage = 'choose' | 'permission' | 'waiting' | 'handoff' | 'original' | 'listen' | 'attempt' | 'processing' | 'round-result' | 'final' | 'error';
const API = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || '').replace(/\/$/, '');
const REMOTE_SESSION_KEY = 'reverse_duel_remote_session';
const REMOTE_SESSION_MS = 30 * 60 * 1000;
type SavedRemoteSession = { id: string; token: string; inviteToken?: string; expiresAt: number };

export default function App() {
  const telegram = useMemo(initTelegram, []);
  const [mode, setMode] = useState<Mode | null>(null), [stage, setStage] = useState<Stage>('choose');
  const [round, setRound] = useState(1), [scores, setScores] = useState<(number | null)[]>([null, null]);
  const [sessionId, setSessionId] = useState<string | null>(null), [match, setMatch] = useState<DuelMatch | null>(null);
  const [token, setToken] = useState(''), [message, setMessage] = useState(''), [recording, setRecording] = useState(false), [playing, setPlaying] = useState(false);
  const ctx = useRef<AudioContext | null>(null), stream = useRef<MediaStream | null>(null), recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<BlobPart[]>([]), originals = useRef<(AudioBuffer | null)[]>([null, null]), attempts = useRef<(AudioBuffer | null)[]>([null, null]), reversed = useRef<AudioBuffer | null>(null), remoteAudio = useRef<AudioBuffer | null>(null);
  const challenger = round, responder = round === 1 ? 2 : 1, player = match?.player ?? 1;
  const inviteUrl = match ? `${location.origin}${location.pathname}?invite=${match.invite_token}` : '';
  const waitingRound = match?.rounds.find((item) => item.status !== 'complete');
  const waitingTitle = !match ? 'Подключаемся к комнате…'
    : match.status === 'waiting_for_player_2' ? 'Позови Игрока 2'
      : waitingRound?.status === 'awaiting_challenge' ? `Вы в игре — Игрок ${waitingRound.challenger} загадывает`
        : waitingRound?.status === 'awaiting_attempt' ? `Игрок ${waitingRound.responder} слушает и повторяет`
          : waitingRound?.status === 'awaiting_score' ? `Игрок ${waitingRound.challenger} сравнивает записи`
            : 'Готовим следующий ход…';

  useEffect(() => {
    void createGameSession({ source: telegram.isTelegram ? 'telegram' : 'web', platform: telegram.isTelegram ? 'telegram_mini_app' : 'web', campaign: 'reverse_duel' }).then(setSessionId).catch(() => undefined);
    void restoreOrJoin();
    return () => { stream.current?.getTracks().forEach((t) => t.stop()); void ctx.current?.close(); };
  }, []);
  useEffect(() => {
    if (!match || !token || match.status === 'finished') return;
    const timer = window.setInterval(() => void getDuelMatch(match.id, token).then(sync).catch(() => undefined), 2000);
    return () => window.clearInterval(timer);
  }, [match?.id, match?.status, token]);

  function context() { return ctx.current ??= createAudioContext(); }
  async function restoreOrJoin() {
    const invite = new URLSearchParams(location.search).get('invite')?.trim() || null;
    const saved = readRemote();

    // An explicit invite must win over a stale room left on this device. If it
    // is the same invite, restore instead of joining twice after a refresh.
    if (invite) {
      if (saved) {
        try {
          const restored = await getDuelMatch(saved.id, saved.token);
          if (restored.invite_token === invite) {
            setMode('remote'); setMatch(restored); setToken(saved.token); rememberRemote(restored, saved.token); clearInviteFromUrl(); sync(restored, restored.player); return;
          }
        } catch { /* A stale saved room must not block a fresh invitation. */ }
      }
      forgetRemote();
      await join(invite);
      return;
    }

    if (!saved) return;
    try {
      const restored = await getDuelMatch(saved.id, saved.token); setMode('remote'); setMatch(restored); setToken(saved.token); sync(restored, restored.player);
    } catch { forgetRemote(); }
  }
  function readRemote(): SavedRemoteSession | null {
    try {
      const saved = JSON.parse(localStorage.getItem(REMOTE_SESSION_KEY) || 'null') as SavedRemoteSession | null;
      if (saved?.id && saved.token && saved.expiresAt > Date.now()) return saved;
    } catch { /* Storage can be disabled in private or embedded browsers. */ }
    forgetRemote(); return null;
  }
  function forgetRemote() { try { localStorage.removeItem(REMOTE_SESSION_KEY); } catch { /* The game still works without persistence. */ } }
  function rememberRemote(next: DuelMatch, playerToken: string) { try { localStorage.setItem(REMOTE_SESSION_KEY, JSON.stringify({ id: next.id, token: playerToken, inviteToken: next.invite_token, expiresAt: Date.now() + REMOTE_SESSION_MS })); } catch { /* The active in-memory match remains usable. */ } }
  function clearInviteFromUrl() { try { const url = new URL(location.href); url.searchParams.delete('invite'); history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`); } catch { /* Cosmetic only. */ } }
  function track(event: string, props: Record<string, unknown> = {}) { void trackEvent(sessionId, event, { mode, round, ...props }); }
  async function mic() { try { await context().resume(); stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); if (mode === 'remote' && match) sync(await getDuelMatch(match.id, token)); else setStage('original'); } catch { fail('Разреши доступ к микрофону и попробуй снова.'); } }
  function fail(text: string) { setMessage(text); setStage('error'); }
  async function choose(value: Mode) { setMode(value); track('duel_mode_selected', { value }); if (value === 'local') setStage('permission'); else try { const created = await createDuelMatch(sessionId); const playerToken = created.player_token!; setMatch(created); setToken(playerToken); rememberRemote(created, playerToken); setStage('waiting'); track('match_created'); } catch { fail('Не удалось создать комнату. Проверь API и хранилище.'); } }
  async function join(invite: string) { setMode('remote'); setStage('waiting'); try { const joined = await joinDuelMatch(invite); const playerToken = joined.player_token!; setMatch(joined); setToken(playerToken); rememberRemote(joined, playerToken); clearInviteFromUrl(); track('match_joined'); setStage('permission'); } catch (error) { fail(error instanceof Error && error.message === 'API timeout' ? 'Сервер долго не отвечает. Проверь интернет и открой приглашение ещё раз.' : 'Комната недоступна, устарела или уже заполнена. Попроси Игрока 1 создать новую ссылку.'); } }
  function sync(next: DuelMatch, currentPlayer = player) {
    setMatch(next); setScores(next.rounds.map((r) => r.score));
    if (next.status === 'finished') return setStage('final');
    if (next.status === 'waiting_for_player_2') return setStage('waiting');
    const active = next.rounds.find((r) => r.status !== 'complete')!; setRound(active.number);
    if (active.challenger === currentPlayer && active.status === 'awaiting_challenge') setStage(stream.current ? 'original' : 'permission');
    else if (active.responder === currentPlayer && active.status === 'awaiting_attempt') void loadChallenge(next.id, active.number);
    else if (active.challenger === currentPlayer && active.status === 'awaiting_score') void scoreAttempt(next.id, active.number);
    else setStage('waiting');
  }
  async function loadChallenge(id: string, n: number) { try { remoteAudio.current = await decodeRecording(context(), await downloadRoundAudio(id, n, 'challenge', token)); originals.current[n - 1] = reverseAudioBuffer(context(), remoteAudio.current); setStage('listen'); } catch { setStage('waiting'); } }
  async function scoreAttempt(id: string, n: number) {
    if (stage === 'processing') return; setStage('processing');
    try { const original = originals.current[n - 1]; if (!original) throw new Error('Локальный оригинал потерян — не закрывай вкладку во время матча.'); const attempt = await decodeRecording(context(), await downloadRoundAudio(id, n, 'attempt', token)); attempts.current[(n === 1 ? 2 : 1) - 1] = attempt; const restored = reverseAudioBuffer(context(), attempt); const result = scoreSignals(audioBufferToMono(original), original.sampleRate, audioBufferToMono(restored), restored.sampleRate); if (!result) throw new Error('Не удалось сравнить звук.'); sync(await submitRoundScore(id, n, token, result)); track('round_scored', { score: result.score }); } catch (e) { fail(e instanceof Error ? e.message : 'Ошибка сравнения'); }
  }
  function start(kind: 'original' | 'attempt') {
    if (!stream.current) return setStage('permission'); const mime = selectRecorderMimeType(); const item = mime ? new MediaRecorder(stream.current, { mimeType: mime }) : new MediaRecorder(stream.current); recorder.current = item; chunks.current = [];
    item.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); }; item.onstop = () => void process(kind, new Blob(chunks.current, { type: item.mimeType || 'audio/webm' })); item.start(100); setRecording(true); window.setTimeout(() => { if (item.state === 'recording') item.stop(); }, 8000); track(`${kind}_recording_started`);
  }
  function stop() { if (recorder.current?.state === 'recording') recorder.current.stop(); }
  async function process(kind: 'original' | 'attempt', blob: Blob) {
    setRecording(false); setStage('processing');
    try { const audio = await decodeRecording(context(), blob); if (!prepareSignal(audioBufferToMono(audio), audio.sampleRate)) throw new Error('Говори чуть громче и не короче секунды.');
      if (kind === 'original') { originals.current[round - 1] = audio; reversed.current = reverseAudioBuffer(context(), audio); if (mode === 'remote') { await uploadRoundAudio(match!.id, round, 'challenge', token, audioBufferToWav(reversed.current)); setStage('waiting'); } else setStage('handoff'); }
      else if (mode === 'remote') { attempts.current[responder - 1] = audio; await uploadRoundAudio(match!.id, round, 'attempt', token, audioBufferToWav(audio)); setStage('waiting'); }
      else { attempts.current[responder - 1] = audio; const restored = reverseAudioBuffer(context(), audio), original = originals.current[round - 1]!; const result = scoreSignals(audioBufferToMono(original), original.sampleRate, audioBufferToMono(restored), restored.sampleRate); if (!result) throw new Error('Не удалось сравнить записи.'); const next = [...scores]; next[responder - 1] = result.score; setScores(next); setStage('round-result'); track('round_scored', { score: result.score }); }
    } catch (e) { fail(e instanceof Error ? e.message : 'Ошибка обработки'); }
  }
  async function play() { const audio = mode === 'remote' ? remoteAudio.current : reversed.current; if (!audio || playing) return; setPlaying(true); await playAudioBuffer(context(), audio); setPlaying(false); track('reverse_audio_played'); }
  async function playSaved(kind: 'original' | 'attempt', playerNumber: number) { const audio = (kind === 'original' ? originals : attempts).current[playerNumber - 1]; if (!audio || playing) return; setPlaying(true); try { await playAudioBuffer(context(), audio); track('final_recording_played', { kind, player: playerNumber }); } finally { setPlaying(false); } }
  function nextRound() { if (round === 1) { setRound(2); reversed.current = null; setStage('handoff'); } else setStage('final'); }
  function reset() { forgetRemote(); setMode(null); setStage('choose'); setRound(1); setScores([null, null]); setMatch(null); originals.current = [null, null]; attempts.current = [null, null]; }
  async function share() { const text = `Дуэль «Скажи наоборот»: Игрок 1 — ${scores[0]}%, Игрок 2 — ${scores[1]}%.`; if (navigator.share) await navigator.share({ title: 'Скажи наоборот', text, url: location.href.split('?')[0] }); else { await navigator.clipboard.writeText(text); alert('Результат скопирован'); } }
  const winner = scores[0] === scores[1] ? 'Ничья 🤝' : `Победитель — Игрок ${scores[0]! > scores[1]! ? 1 : 2} 🏆`;

  return <main className="app-shell"><header className="brandbar"><div className="brandmark">S</div><div><strong>Сонграйтер</strong><span>reverse-speech дуэль</span></div><div className="brandbar__pill">2×</div></header><section className="game-card">
    {stage === 'choose' && <Screen><div className="hero-icon">↶</div><p className="eyebrow">ГОЛОСОВАЯ ДУЭЛЬ</p><h1>Скажи наоборот<br />вдвоём</h1><p className="lead">Один загадывает фразу, второй слышит её наоборот и повторяет. Потом меняетесь ролями.</p><button className="button button--primary" onClick={() => void choose('local')}>📱 Вдвоём на одном устройстве</button><button className="button button--secondary mode-button" onClick={() => void choose('remote')}>🔗 Вдвоём на разных устройствах</button></Screen>}
    {stage === 'permission' && <Screen><p className="eyebrow">ИГРОК {mode === 'remote' ? player : challenger}</p><h2>Нужен микрофон</h2><p className="lead">Оригинал остаётся на устройстве. Онлайн передаёт только перевёрнутый звук и попытку на 10–30 минут.</p><button className="button button--primary" onClick={() => void mic()}>Разрешить микрофон</button></Screen>}
    {stage === 'waiting' && <Screen><div className="spinner" /><h2>{waitingTitle}</h2>{match?.status === 'waiting_for_player_2' ? <><p className="lead">Отправь другу приватную ссылку на комнату.</p><button className="button button--primary" onClick={() => void navigator.clipboard.writeText(inviteUrl)}>Копировать приглашение</button></> : <p className="lead">Ты уже подключён. Экран сам переключится, когда соперник закончит свой ход.</p>}<p className="privacy-note">Оставь вкладку открытой — ход обновится автоматически.</p></Screen>}
    {stage === 'handoff' && <Screen><div className="permission-icon">📱</div><p className="eyebrow">РАУНД {round} ИЗ 2</p><h2>Передай телефон Игроку {reversed.current ? responder : challenger}</h2><p className="lead">Каждый игрок видит только свой ход.</p><button className="button button--primary" onClick={() => setStage(reversed.current ? 'listen' : 'original')}>Телефон передан</button></Screen>}
    {stage === 'original' && <Record title={`Игрок ${challenger} загадывает`} subtitle="Слово или короткая фраза, лучше 2–6 секунд." recording={recording} action={() => recording ? stop() : start('original')} />}
    {stage === 'listen' && <Screen><p className="eyebrow">ИГРОК {responder} СЛУШАЕТ</p><h2>Запомни звук наоборот</h2><p className="lead">Оригинал скрыт. Повтори странные звуки как можно точнее.</p><button className="button button--secondary" disabled={playing} onClick={() => void play()}>▶ Слушать наоборот</button><button className="button button--primary mode-button" onClick={() => setStage('attempt')}>🎙 Повторить</button></Screen>}
    {stage === 'attempt' && <Record title={`Игрок ${responder} повторяет`} subtitle="Повтори услышанный обратный звук." recording={recording} action={() => recording ? stop() : start('attempt')} />}
    {stage === 'processing' && <Screen><div className="spinner" /><h2>Сравниваем…</h2><p className="lead">Попытка разворачивается обратно, score считается на устройстве загадчика.</p></Screen>}
    {stage === 'round-result' && <Screen><p className="eyebrow">РАУНД {round}</p><div className="score-ring"><strong>{scores[responder - 1]}%</strong></div><h2>Результат Игрока {responder}</h2><button className="button button--primary" onClick={nextRound}>{round === 1 ? 'Поменяться ролями' : 'Общий результат'}</button></Screen>}
    {stage === 'final' && <div className="screen"><div className="result-head"><p className="eyebrow">ДУЭЛЬ ЗАВЕРШЕНА</p><h2>{winner}</h2></div><div className="duel-scores"><div><span>Игрок 1</span><strong>{scores[0]}%</strong></div><div><span>Игрок 2</span><strong>{scores[1]}%</strong></div></div><div className="recording-replay"><h3>Прослушать записи</h3>{[1, 2].map((number) => <div className="recording-replay__player" key={number}><strong>Игрок {number}</strong><div><button disabled={playing || !originals.current[number - 1]} onClick={() => void playSaved('original', number)}>▶ Что загадал</button><button disabled={playing || !attempts.current[number - 1]} onClick={() => void playSaved('attempt', number)}>▶ Как повторил</button></div></div>)}<p>Записи доступны только на этом устройстве до закрытия игры.</p></div><button className="button button--secondary" onClick={() => void share()}>Поделиться</button><button className="button button--ghost" onClick={reset}>Реванш</button><div className="easysong-card"><div className="easysong-card__icon">♫</div><div><h3>А теперь преврати свою идею в песню</h3><p>Создавай песни, картинки, открытки и не только с Сонграйтером / EasySong.</p></div><a className="button button--white" href={API ? `${API}/go/easysong?source=game&campaign=reverse_duel` : 'https://easysong.ru/webapp/auth?next=%2Fwebapp'} onClick={() => track('easysong_clicked')}>Попробовать EasySong →</a></div></div>}
    {stage === 'error' && <Screen><div className="error-icon">!</div><h2>Не получилось</h2><p className="lead">{message}</p><button className="button button--primary" onClick={reset}>В начало</button></Screen>}
  </section><footer className="footer-note"><span>Оригинал не загружается</span><span>•</span><span>{telegram.isTelegram ? 'Telegram Mini App' : 'Web'}</span></footer></main>;
}

function Screen({ children }: { children: ReactNode }) { return <div className="screen screen--center">{children}</div>; }
function Record({ title, subtitle, recording, action }: { title: string; subtitle: string; recording: boolean; action: () => void }) { return <Screen><p className="eyebrow">ЗАПИСЬ</p><h2>{recording ? 'Говори…' : title}</h2><p className="lead">{subtitle}</p><div className={recording ? 'waveform waveform--active' : 'waveform'}>{Array.from({ length: 17 }, (_, i) => <span key={i} style={{ '--bar': i } as CSSProperties} />)}</div><button className={recording ? 'mic-button mic-button--recording' : 'mic-button'} onClick={action}><span>{recording ? '■' : '●'}</span></button><strong className="timer">{recording ? 'Нажми, чтобы закончить' : 'До 8 секунд'}</strong></Screen>; }
