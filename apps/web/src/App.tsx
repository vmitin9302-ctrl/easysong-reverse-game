import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { prepareSignal } from '@reverse-game/audio-engine';
import {
  cancelDuelMatch, createDuelMatch, createGameSession, downloadRoundAudio, forfeitDuelMatch,
  getDuelMatch, heartbeatDuelMatch, joinDuelMatch, markRoundResultSeen, submitRoundGuess, submitRoundPhrase,
  trackEvent, updateDuelActivity, uploadRoundAudio, type DuelMatch,
} from './api';
import {
  audioBufferToMono, audioBufferToWav, createAudioContext, decodeRecording,
  normalizedGameAudio, playAudioBuffer, reverseAudioBuffer, selectRecorderMimeType,
} from './audio/browserAudio';
import { initTelegram } from './telegram';
import { remoteTurnAction } from './duelState';
import './styles.css';

type Mode = 'local' | 'remote';
type Stage = 'choose' | 'waiting' | 'phrase' | 'permission' | 'handoff' | 'original' | 'review-original' | 'listen' | 'audio-error' | 'attempt' | 'processing' | 'guess' | 'watch-guess' | 'round-result' | 'final' | 'error';
const API = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || '').replace(/\/$/, '');
const REMOTE_SESSION_KEY = 'reverse_duel_remote_session';
const REMOTE_SESSION_MS = 24 * 60 * 60 * 1000;
type SavedRemoteSession = { id: string; token: string; inviteToken?: string; expiresAt: number };

export default function App() {
  const telegram = useMemo(initTelegram, []);
  const [mode, setMode] = useState<Mode | null>(null);
  const [stage, setStage] = useState<Stage>('choose');
  const [round, setRound] = useState(1);
  const [scores, setScores] = useState<(number | null)[]>([null, null]);
  const [forfeitedBy, setForfeitedBy] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [match, setMatch] = useState<DuelMatch | null>(null);
  const [token, setToken] = useState('');
  const [phraseText, setPhraseText] = useState('');
  const [guessText, setGuessText] = useState('');
  const [message, setMessage] = useState('');
  const [inviteNotice, setInviteNotice] = useState('');
  const [playbackError, setPlaybackError] = useState('');
  const [recording, setRecording] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [connection, setConnection] = useState<'online' | 'reconnecting' | 'restored'>('online');

  const ctx = useRef<AudioContext | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<BlobPart[]>([]);
  const originals = useRef<(AudioBuffer | null)[]>([null, null]);
  const attempts = useRef<(AudioBuffer | null)[]>([null, null]);
  const challengeAudio = useRef<AudioBuffer | null>(null);
  const restoredAttempt = useRef<AudioBuffer | null>(null);
  const recordingKind = useRef<'original' | 'attempt'>('original');
  const tokenRef = useRef('');
  const localFlowLocked = useRef(false);
  const loadingAudio = useRef(false);
  const loadedChallengeRound = useRef<number | null>(null);
  const loadedAttemptRound = useRef<number | null>(null);
  const audioRetry = useRef<{ number: number; kind: 'challenge' | 'attempt'; target?: 'guess' | 'watch-guess' | 'round-result' } | null>(null);
  const revisionRef = useRef(0);
  const pollFailures = useRef(0);

  const player = match?.player ?? 1;
  const challenger = round;
  const responder = round === 1 ? 2 : 1;
  const activeRound = match?.rounds.find((item) => item.status !== 'complete');
  const currentRound = match?.rounds.find((item) => item.number === round);
  const inviteUrl = match ? `${location.origin}${location.pathname}?invite=${match.invite_token}` : '';
  const waitingTitle = !match ? 'Подключаемся к комнате…'
    : match.status === 'waiting_for_player_2' ? 'Позови Игрока 2'
      : activeRound?.status === 'awaiting_phrase' ? `Игрок ${activeRound.challenger} придумывает секретную фразу`
        : activeRound?.status === 'awaiting_challenge' ? `Игрок ${activeRound.challenger} записывает фразу`
          : activeRound?.status === 'awaiting_attempt' ? `Игрок ${activeRound.responder} слушает и повторяет звук`
            : activeRound?.status === 'awaiting_guess' ? `Игрок ${activeRound.responder} слушает результат и угадывает фразу`
              : 'Готовим следующий ход…';

  useEffect(() => {
    void createGameSession({
      source: telegram.isTelegram ? 'telegram' : 'web',
      platform: telegram.isTelegram ? 'telegram_mini_app' : 'web',
      campaign: 'reverse_duel',
    }).then(setSessionId).catch(() => undefined);
    void restoreOrJoin();
    return () => { stream.current?.getTracks().forEach((track) => track.stop()); void ctx.current?.close(); };
  }, []);

  useEffect(() => {
    if (!match || !token || match.status === 'cancelled' || match.status === 'finished' || match.status.startsWith('forfeited_by_')) return;
    let stopped = false;
    const refresh = () => void getDuelMatch(match.id, token).then((next) => {
      if (stopped) return;
      const wasOffline = pollFailures.current > 0;
      pollFailures.current = 0;
      if (wasOffline) {
        setConnection('restored');
        window.setTimeout(() => setConnection((current) => current === 'restored' ? 'online' : current), 2500);
      }
      if (next.revision > revisionRef.current) sync(next, next.player);
    }).catch(() => {
      pollFailures.current += 1;
      if (pollFailures.current >= 2) setConnection('reconnecting');
    });
    const heartbeat = () => void heartbeatDuelMatch(match.id, token).catch(() => {
      pollFailures.current += 1;
      if (pollFailures.current >= 2) setConnection('reconnecting');
    });
    const reconnectNow = () => { heartbeat(); refresh(); };
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') reconnectNow(); };
    const timer = window.setInterval(refresh, 1000);
    const heartbeatTimer = window.setInterval(heartbeat, 5000);
    window.addEventListener('focus', reconnectNow);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      stopped = true; window.clearInterval(timer); window.clearInterval(heartbeatTimer);
      window.removeEventListener('focus', reconnectNow); document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [match?.id, match?.status, token]);

  function context() { return ctx.current ??= createAudioContext(); }
  function applyPlayerToken(value: string) { tokenRef.current = value; setToken(value); }
  function releaseMicrophone() { stream.current?.getTracks().forEach((track) => track.stop()); stream.current = null; }
  async function requestMicrophone() {
    releaseMicrophone();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone API unavailable');
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (error) {
      if (!(error instanceof DOMException) || !['OverconstrainedError', 'NotFoundError'].includes(error.name)) throw error;
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    return stream.current;
  }

  async function restoreOrJoin() {
    const invite = new URLSearchParams(location.search).get('invite')?.trim() || null;
    const saved = readRemote();
    if (invite) {
      if (saved) {
        try {
          const restored = await getDuelMatch(saved.id, saved.token);
          if (restored.invite_token === invite) {
            setMode('remote'); setMatch(restored); applyPlayerToken(saved.token); rememberRemote(restored, saved.token);
            clearInviteFromUrl(); sync(restored, restored.player); return;
          }
        } catch { /* A stale room must not block a fresh invitation. */ }
      }
      const resumeToken = saved?.inviteToken === invite ? saved.token : undefined;
      if (!resumeToken) forgetRemote();
      await join(invite, resumeToken);
      return;
    }
    if (!saved) return;
    try {
      const restored = await getDuelMatch(saved.id, saved.token);
      setMode('remote'); setMatch(restored); applyPlayerToken(saved.token); sync(restored, restored.player);
    } catch { forgetRemote(); }
  }

  function readRemote(): SavedRemoteSession | null {
    try {
      const saved = JSON.parse(localStorage.getItem(REMOTE_SESSION_KEY) || 'null') as SavedRemoteSession | null;
      if (saved?.id && saved.token && saved.expiresAt > Date.now()) return saved;
    } catch { /* Storage can be disabled in private or embedded browsers. */ }
    forgetRemote(); return null;
  }
  function forgetRemote() { try { localStorage.removeItem(REMOTE_SESSION_KEY); } catch { /* In-memory play still works. */ } }
  function rememberRemote(next: DuelMatch, playerToken: string) {
    try {
      localStorage.setItem(REMOTE_SESSION_KEY, JSON.stringify({ id: next.id, token: playerToken, inviteToken: next.invite_token, expiresAt: Date.now() + REMOTE_SESSION_MS }));
    } catch { /* The current match remains available in memory. */ }
  }
  function clearInviteFromUrl() {
    try {
      const url = new URL(location.href); url.searchParams.delete('invite');
      history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch { /* Cosmetic only. */ }
  }
  function track(event: string, props: Record<string, unknown> = {}) { void trackEvent(sessionId, event, { mode, round, ...props }); }
  function activity(status: string) { if (mode === 'remote' && match && tokenRef.current) void updateDuelActivity(match.id, tokenRef.current, status).catch(() => undefined); }

  function chooseLocal() {
    setMode('local'); setStage('permission'); track('duel_mode_selected', { mode: 'local', value: 'local' });
  }

  async function createRoom() {
    setMode('remote'); setStage('waiting');
    try {
      const created = await createDuelMatch(sessionId);
      const playerToken = created.player_token!;
      setMatch(created); applyPlayerToken(playerToken); rememberRemote(created, playerToken); track('match_created', { mode: 'remote' });
    } catch { fail('Не удалось создать комнату. Проверь соединение и попробуй ещё раз.'); }
  }

  async function join(invite: string, resumeToken?: string) {
    setMode('remote'); setStage('waiting');
    try {
      const joined = await joinDuelMatch(invite, resumeToken);
      const playerToken = joined.player_token!;
      setMatch(joined); applyPlayerToken(playerToken); rememberRemote(joined, playerToken); clearInviteFromUrl();
      track(resumeToken ? 'match_resumed' : 'match_joined'); sync(joined, joined.player);
    } catch (error) {
      fail(error instanceof Error && error.message === 'API timeout'
        ? 'Сервер долго не отвечает. Проверь интернет и открой приглашение ещё раз.'
        : 'Комната недоступна, устарела или уже заполнена. Попроси Игрока 1 создать новую ссылку.');
    }
  }

  function sync(next: DuelMatch, currentPlayer = player) {
    if (next.revision < revisionRef.current) return;
    revisionRef.current = next.revision; setMatch(next); setScores(next.scores);
    const decision = remoteTurnAction(next, currentPlayer, {
      localFlowLocked: localFlowLocked.current || loadingAudio.current,
      hasMicrophone: Boolean(stream.current),
      loadedChallengeRound: challengeAudio.current ? loadedChallengeRound.current : null,
      loadedAttemptRound: restoredAttempt.current ? loadedAttemptRound.current : null,
    });
    if (decision.round) setRound(decision.round);
    if (decision.action === 'cancelled') { forgetRemote(); setMode(null); setMatch(null); setStage('choose'); }
    else if (decision.action === 'final') { if (next.forfeited_by) setForfeitedBy(next.forfeited_by); setStage('final'); }
    else if (decision.action === 'waiting') setStage('waiting');
    else if (decision.action === 'enter-phrase') {
      const row = next.rounds.find((item) => item.number === decision.round);
      setPhraseText(row?.phrase || ''); setStage('phrase');
    } else if (decision.action === 'permission') setStage('permission');
    else if (decision.action === 'record-original') setStage('original');
    else if (decision.action === 'listen') setStage('listen');
    else if (decision.action === 'load-challenge') void loadAudio(next.id, decision.round!, 'challenge');
    else if (decision.action === 'load-attempt') void loadAudio(next.id, decision.round!, 'attempt', decision.attemptTarget);
    else if (decision.action === 'guess') setStage('guess');
    else if (decision.action === 'watch-guess') setStage('watch-guess');
    else if (decision.action === 'round-result') setStage('round-result');
  }

  async function submitPhrase() {
    const phrase = phraseText.trim();
    if (!phrase) return setMessage('Напиши слово или короткую фразу.');
    if (!match) return;
    setMessage(''); setSubmitting(true); localFlowLocked.current = true;
    try {
      const next = await submitRoundPhrase(match.id, round, tokenRef.current, phrase);
      localFlowLocked.current = false; track('phrase_submitted', { length: phrase.length }); sync(next, next.player);
    } catch {
      localFlowLocked.current = false; setMessage('Не удалось сохранить фразу. Проверь соединение и попробуй ещё раз.');
    } finally { setSubmitting(false); }
  }

  async function mic() {
    setMicBusy(true);
    try {
      await context().resume(); await requestMicrophone();
      if (mode === 'local') { setStage('original'); return; }
      if (!match) throw new Error('Match unavailable');
      const latest = await getDuelMatch(match.id, tokenRef.current);
      const active = latest.rounds.find((item) => item.status !== 'complete');
      if (active?.challenger !== latest.player || active.status !== 'awaiting_challenge') releaseMicrophone();
      sync(latest, latest.player);
    } catch {
      releaseMicrophone(); fail('Не удалось включить микрофон. Проверь разрешение для сайта в настройках браузера.');
    } finally { setMicBusy(false); }
  }

  async function loadAudio(id: string, number: number, kind: 'challenge' | 'attempt', target?: 'guess' | 'watch-guess' | 'round-result') {
    if (loadingAudio.current) return;
    loadingAudio.current = true; audioRetry.current = { number, kind, target };
    try {
      const decoded = await decodeRecording(context(), await downloadRoundAudio(id, number, kind, tokenRef.current));
      if (kind === 'challenge') {
        challengeAudio.current = decoded; loadedChallengeRound.current = number; setStage('listen');
      } else {
        restoredAttempt.current = reverseAudioBuffer(context(), decoded); loadedAttemptRound.current = number; setStage(target || 'guess');
      }
      setPlaybackError('');
    } catch {
      setPlaybackError('Не удалось загрузить запись. Проверь интернет и нажми «Загрузить ещё раз».'); setStage('audio-error');
    } finally { loadingAudio.current = false; }
  }

  async function start(kind: 'original' | 'attempt') {
    localFlowLocked.current = true; recordingKind.current = kind; setMicBusy(true);
    try {
      const activeStream = stream.current ?? await requestMicrophone();
      const mime = selectRecorderMimeType();
      const item = mime ? new MediaRecorder(activeStream, { mimeType: mime }) : new MediaRecorder(activeStream);
      recorder.current = item; chunks.current = [];
      item.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data); };
      item.onstop = () => {
        const blob = new Blob(chunks.current, { type: item.mimeType || 'audio/webm' });
        releaseMicrophone(); activity(kind === 'original' ? 'processing_challenge' : 'processing_attempt'); void process(kind, blob);
      };
      item.start(100); setRecording(true); setMicBusy(false);
      activity(kind === 'original' ? 'recording_challenge' : 'recording_attempt');
      window.setTimeout(() => { if (item.state === 'recording') item.stop(); }, 8000);
      track(`${kind}_recording_started`);
    } catch {
      localFlowLocked.current = false; setMicBusy(false); releaseMicrophone(); fail('Не удалось включить микрофон. Проверь разрешение браузера.');
    }
  }

  function stop() { if (recorder.current?.state === 'recording') recorder.current.stop(); }

  async function process(kind: 'original' | 'attempt', blob: Blob) {
    setRecording(false); setStage('processing');
    try {
      const decoded = await decodeRecording(context(), blob);
      const prepared = prepareSignal(audioBufferToMono(decoded), decoded.sampleRate);
      if (!prepared) throw new Error('Говори чуть громче и не короче секунды.');
      const audio = normalizedGameAudio(context(), prepared.samples, prepared.sampleRate);
      if (kind === 'original') {
        originals.current[round - 1] = audio;
        challengeAudio.current = reverseAudioBuffer(context(), audio);
        activity('listening_challenge'); setPlaybackError(''); setStage('review-original');
      } else {
        attempts.current[responder - 1] = audio;
        restoredAttempt.current = reverseAudioBuffer(context(), audio); loadedAttemptRound.current = round;
        if (mode === 'local') {
          localFlowLocked.current = false; setStage('round-result'); track('attempt_recorded'); return;
        }
        if (!match) throw new Error('Комната недоступна.');
        activity('sending_attempt');
        await uploadRoundAudio(match.id, round, 'attempt', tokenRef.current, audioBufferToWav(audio));
        const latest = await getDuelMatch(match.id, tokenRef.current);
        localFlowLocked.current = false; sync(latest, latest.player); track('attempt_uploaded');
      }
    } catch (error) {
      localFlowLocked.current = false; fail(error instanceof Error ? error.message : 'Ошибка обработки записи');
    }
  }

  async function confirmOriginal() {
    if (!challengeAudio.current) { localFlowLocked.current = false; return setStage('original'); }
    if (mode === 'local') {
      localFlowLocked.current = false; setStage('handoff'); track('challenge_confirmed'); return;
    }
    if (!match) { localFlowLocked.current = false; return setStage('original'); }
    localFlowLocked.current = true; setStage('processing');
    try {
      activity('sending_challenge');
      await uploadRoundAudio(match.id, round, 'challenge', tokenRef.current, audioBufferToWav(challengeAudio.current));
      const latest = await getDuelMatch(match.id, tokenRef.current);
      localFlowLocked.current = false; sync(latest, latest.player); track('challenge_confirmed');
    } catch {
      localFlowLocked.current = false; fail('Не удалось отправить запись. Проверь интернет и попробуй ещё раз.');
    }
  }

  async function play() {
    const restoredPlayback = stage === 'guess' || stage === 'watch-guess' || stage === 'round-result';
    const audio = restoredPlayback ? restoredAttempt.current : challengeAudio.current;
    if (!audio || playing) return;
    if (stage === 'listen') activity('listening_challenge_by_opponent');
    if (stage === 'guess') activity('listening_restored_attempt');
    releaseMicrophone(); setPlaying(true); setPlaybackError('');
    try {
      await playAudioBuffer(context(), audio);
      track(restoredPlayback ? 'restored_attempt_played' : 'reverse_audio_played');
    } catch { setPlaybackError('Звук не запустился. Увеличь громкость и нажми ещё раз.'); }
    finally { setPlaying(false); }
  }

  async function playSaved(kind: 'original' | 'attempt', playerNumber: number) {
    const audio = (kind === 'original' ? originals : attempts).current[playerNumber - 1];
    if (!audio || playing) return;
    releaseMicrophone(); setPlaying(true); setPlaybackError('');
    try { await playAudioBuffer(context(), audio); track('final_recording_played', { kind, player: playerNumber }); }
    catch { setPlaybackError('Не удалось включить запись. Проверь громкость и нажми ещё раз.'); }
    finally { setPlaying(false); }
  }

  async function submitGuess() {
    const guess = guessText.trim();
    if (!guess) return setMessage('Напиши, какую фразу ты услышал.');
    if (!match) return;
    setMessage(''); setSubmitting(true); localFlowLocked.current = true; activity('guessing_phrase');
    try {
      const resultRound = round;
      const next = await submitRoundGuess(match.id, resultRound, tokenRef.current, guess);
      localFlowLocked.current = false; revisionRef.current = next.revision; setMatch(next); setScores(next.scores); setRound(resultRound); setStage('round-result');
      track('guess_submitted', { score: next.rounds.find((item) => item.number === resultRound)?.score });
    } catch {
      localFlowLocked.current = false; setMessage('Не удалось отправить ответ. Проверь соединение и попробуй ещё раз.');
    } finally { setSubmitting(false); }
  }

  async function continueAfterResult() {
    if (!match) return;
    setSubmitting(true); setMessage('');
    try {
      const next = await markRoundResultSeen(match.id, round, tokenRef.current);
      localFlowLocked.current = false; challengeAudio.current = null; restoredAttempt.current = null;
      loadedChallengeRound.current = null; loadedAttemptRound.current = null; audioRetry.current = null;
      setPhraseText(''); setGuessText(''); setPlaybackError(''); sync(next, next.player);
    } catch { setMessage('Не удалось продолжить. Проверь соединение и попробуй ещё раз.'); }
    finally { setSubmitting(false); }
  }

  function nextLocalRound() {
    if (round === 1) {
      setRound(2); challengeAudio.current = null; restoredAttempt.current = null;
      loadedChallengeRound.current = null; loadedAttemptRound.current = null; setPlaybackError(''); setStage('handoff');
    } else setStage('final');
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteUrl); setInviteNotice('Ссылка скопирована. Отправь её второму игроку.'); track('invite_copied');
    } catch { setInviteNotice('Не удалось скопировать автоматически. Нажми и удерживай ссылку ниже.'); }
  }
  async function shareInvite() {
    if (!inviteUrl) return;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Скажи наоборот — онлайн-дуэль', text: 'Присоединяйся к моей голосовой дуэли', url: inviteUrl });
        track('invite_shared'); return;
      }
      await copyInvite();
    } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) await copyInvite(); }
  }
  async function cancelRoom() {
    if (!match || !tokenRef.current || !window.confirm('Отменить комнату? Ссылка перестанет работать.')) return;
    try { await cancelDuelMatch(match.id, tokenRef.current); track('match_cancelled'); reset(); }
    catch { try { sync(await getDuelMatch(match.id, tokenRef.current)); } catch { fail('Не удалось отменить комнату. Попробуй ещё раз.'); } }
  }
  async function forfeit() {
    if (mode === 'local') {
      const localPlayer = ['listen', 'attempt', 'guess'].includes(stage) || (stage === 'processing' && recordingKind.current === 'attempt')
        || (stage === 'handoff' && Boolean(challengeAudio.current)) ? responder : challenger;
      if (!window.confirm(`Игрок ${localPlayer} сдаётся? Матч сразу завершится.`)) return;
      localFlowLocked.current = false; releaseMicrophone(); setForfeitedBy(localPlayer); setStage('final');
      track('match_forfeited', { player: localPlayer }); return;
    }
    if (!match || !window.confirm(`Игрок ${player} сдаётся? Матч сразу завершится.`)) return;
    localFlowLocked.current = false; releaseMicrophone();
    try { sync(await forfeitDuelMatch(match.id, tokenRef.current), player); track('match_forfeited', { player }); }
    catch { fail('Не удалось завершить матч. Проверь интернет и попробуй ещё раз.'); }
  }

  function fail(text: string) {
    localFlowLocked.current = false; loadingAudio.current = false; setMicBusy(false); setSubmitting(false); setRecording(false);
    releaseMicrophone(); setMessage(text); setStage('error');
  }
  function reset() {
    tokenRef.current = ''; setToken(''); revisionRef.current = 0; pollFailures.current = 0; setConnection('online');
    localFlowLocked.current = false; loadingAudio.current = false; loadedChallengeRound.current = null; loadedAttemptRound.current = null;
    releaseMicrophone(); forgetRemote(); setMode(null); setStage('choose'); setRound(1); setScores([null, null]); setForfeitedBy(null); setMatch(null);
    setPhraseText(''); setGuessText(''); setMessage(''); setInviteNotice(''); setPlaybackError('');
    originals.current = [null, null]; attempts.current = [null, null]; challengeAudio.current = null; restoredAttempt.current = null; audioRetry.current = null;
  }
  function exitFinishedMatch() { track('match_exited'); reset(); }
  async function share() {
    const text = forfeitedBy
      ? `Дуэль «Скажи наоборот»: Игрок ${forfeitedBy} сдался, победил Игрок ${forfeitedBy === 1 ? 2 : 1}.`
      : mode === 'local' ? 'Мы сыграли в «Скажи наоборот» на одном устройстве 😄'
        : `Дуэль «Скажи наоборот»: Игрок 1 — ${scores[0]}%, Игрок 2 — ${scores[1]}%.`;
    if (navigator.share) await navigator.share({ title: 'Скажи наоборот', text, url: location.href.split('?')[0] });
    else { await navigator.clipboard.writeText(text); alert('Результат скопирован'); }
  }

  const resultRow = match?.rounds.find((item) => item.number === round);
  const winner = forfeitedBy
    ? `Игрок ${forfeitedBy} сдался — победил Игрок ${forfeitedBy === 1 ? 2 : 1} 🏆`
    : mode === 'local' ? 'Вот это было смешно 😄'
      : scores[0] === scores[1] ? 'Ничья 🤝'
      : `Победитель — Игрок ${mode === 'remote' && match?.winner ? match.winner : scores[0]! > scores[1]! ? 1 : 2} 🏆`;
  const canForfeit = Boolean(mode && !['choose', 'final', 'error', 'round-result'].includes(stage)
    && (mode === 'local' || Boolean(match && ['round_1', 'round_2'].includes(match.status))));
  const opponentLastSeen = player === 1 ? match?.player_two_last_seen_at : match?.player_one_last_seen_at;
  const opponentOnline = Boolean(opponentLastSeen && Date.now() - new Date(opponentLastSeen).getTime() < 15_000);
  const activityText = liveActivityText(match, player);
  const displayedRound = ['watch-guess', 'round-result'].includes(stage) ? round : match?.current_round;

  return <main className="app-shell">
    <header className="brandbar"><div className="brandmark">S</div><div><strong>Сонграйтер</strong><span>reverse-speech дуэль</span></div><div className="brandbar__pill">2×</div></header>
    {mode === 'remote' && match && <>
      <div className={`connection-bar connection-bar--${connection}`}><span>{connection === 'reconnecting' ? '🟡 Переподключаемся…' : connection === 'restored' ? '✅ Соединение восстановлено' : match.status === 'waiting_for_player_2' ? '🟡 Ждём соперника' : opponentOnline ? '🟢 Соперник онлайн' : '🟡 Соперник переподключается'}</span><span>Раунд {displayedRound}/2</span></div>
      {match.current_round === 2 && scores[1] !== null && !(stage === 'round-result' && round === 1) && <div className="round-score-banner">Раунд 1: Игрок 2 угадал на <strong>{scores[1]}%</strong></div>}
    </>}
    <section className="game-card">
      {stage === 'choose' && <Screen><div className="hero-icon">↶</div><p className="eyebrow">ГОЛОСОВАЯ ДУЭЛЬ</p><h1>Скажи наоборот<br />вдвоём</h1><p className="lead">Играй рядом с другом на одном телефоне или создай онлайн-комнату для двух устройств.</p><button className="button button--primary" onClick={chooseLocal}>📱 Вдвоём на одном устройстве</button><button className="button button--secondary mode-button" onClick={() => void createRoom()}>🔗 Вдвоём на разных устройствах</button><p className="privacy-note">Выбери удобный способ — оба режима доступны.</p></Screen>}

      {stage === 'waiting' && <Screen><div className="spinner" /><h2>{activityText || waitingTitle}</h2>{match?.status === 'waiting_for_player_2' ? <><p className="lead">Отправь другу приватную ссылку. Игра начнётся автоматически, когда он подключится.</p><button className="button button--primary" onClick={() => void shareInvite()}>Поделиться приглашением</button><button className="button button--secondary mode-button" onClick={() => void copyInvite()}>Копировать ссылку</button><a className="invite-link" href={inviteUrl}>{inviteUrl}</a>{inviteNotice && <p className="invite-notice">{inviteNotice}</p>}<button className="button button--ghost" onClick={() => void cancelRoom()}>Отменить комнату</button></> : <p className="lead">Экран переключится сам, когда соперник закончит свой шаг.</p>}<p className="privacy-note">Игру можно свернуть: после возвращения ход восстановится.</p></Screen>}

      {stage === 'phrase' && <Screen><div className="permission-icon">✍️</div><p className="eyebrow">РАУНД {round} ИЗ 2 · ИГРОК {challenger}</p><h2>Загадай секретную фразу</h2><p className="lead">Напиши то, что сейчас произнесёшь. Соперник не увидит текст до своей догадки.</p><div className="text-entry"><input autoFocus maxLength={160} value={phraseText} onFocus={() => activity('writing_phrase')} onChange={(event) => { setPhraseText(event.target.value); setMessage(''); }} placeholder="Например: сегодня отличный день" /><span>{phraseText.length}/160</span></div>{message && <p className="audio-warning">{message}</p>}<button className="button button--primary" disabled={submitting || !phraseText.trim()} onClick={() => void submitPhrase()}>{submitting ? 'Сохраняем…' : 'Сохранить и записать'}</button></Screen>}

      {stage === 'permission' && <Screen><p className="eyebrow">ИГРОК {mode === 'remote' ? player : challenger} · РАУНД {round}</p><h2>{micBusy ? 'Включаем микрофон…' : mode === 'remote' ? 'Теперь запиши фразу' : 'Нужен микрофон'}</h2>{mode === 'remote' ? <><div className="secret-phrase"><span>Твоя фраза</span><strong>{currentRound?.phrase || phraseText}</strong></div><p className="lead">Оригинал останется на этом устройстве. Соперник получит только перевёрнутый звук.</p></> : <p className="lead">Записи обрабатываются прямо на этом устройстве и никуда не отправляются.</p>}<button className="button button--primary" disabled={micBusy} onClick={() => void mic()}>{micBusy ? 'Подожди…' : 'Разрешить микрофон'}</button></Screen>}

      {stage === 'handoff' && <Screen><div className="permission-icon">📱</div><p className="eyebrow">РАУНД {round} ИЗ 2</p><h2>Передай устройство Игроку {challengeAudio.current ? responder : challenger}</h2><p className="lead">Каждый игрок видит только свой ход.</p><button className="button button--primary" onClick={() => setStage(challengeAudio.current ? 'listen' : 'original')}>Устройство передано</button></Screen>}

      {stage === 'original' && <Record title={`Игрок ${challenger} записывает фразу`} subtitle={mode === 'remote' ? `Произнеси точно: «${currentRound?.phrase || phraseText}»` : 'Скажи любое слово или короткую фразу.'} recording={recording} busy={micBusy} action={() => recording ? stop() : void start('original')} />}

      {stage === 'review-original' && <Screen><p className="eyebrow">ПРОВЕРКА ЗАДАНИЯ</p><h2>{mode === 'remote' ? 'Так услышит соперник' : 'Слышно хорошо?'}</h2><p className="lead">{mode === 'remote' ? 'Проверь перевёрнутый звук перед отправкой.' : `Это перевёрнутый звук, который услышит Игрок ${responder}.`}</p><button className="button button--secondary" disabled={playing} onClick={() => void play()}>▶ Слушать наоборот</button>{playbackError && <p className="audio-warning">{playbackError}</p>}<button className="button button--primary mode-button" onClick={() => void confirmOriginal()}>{mode === 'remote' ? 'Отправить сопернику' : 'Всё слышно — продолжить'}</button><button className="button button--ghost" onClick={() => { challengeAudio.current = null; setStage('original'); }}>Перезаписать</button></Screen>}

      {stage === 'listen' && <Screen><div className="audio-orb">▶</div><p className="eyebrow">ИГРОК {responder} · РАУНД {round}</p><h2>Послушай звук наоборот</h2><p className="lead">Текст скрыт. Запомни странное звучание и повтори его как можно точнее.</p><button className="button button--secondary" disabled={playing} onClick={() => void play()}>▶ Слушать запись</button>{playbackError && <p className="audio-warning">{playbackError}</p>}<button className="button button--primary mode-button" onClick={() => { localFlowLocked.current = true; setStage('attempt'); }}>🎙 Повторить услышанное</button></Screen>}

      {stage === 'attempt' && <Record title={`Игрок ${responder} повторяет звук`} subtitle="Произнеси именно те обратные звуки, которые только что услышал." recording={recording} busy={micBusy} action={() => recording ? stop() : void start('attempt')} />}

      {stage === 'guess' && <Screen><div className="permission-icon">🧠</div><p className="eyebrow">ПОСЛЕДНИЙ ШАГ · РАУНД {round}</p><h2>Угадай исходную фразу</h2><p className="lead">Мы развернули твою запись обратно. Послушай, что получилось, и напиши услышанную фразу.</p><button className="button button--secondary" disabled={playing} onClick={() => void play()}>▶ Слушать свою запись нормально</button>{playbackError && <p className="audio-warning">{playbackError}</p>}<div className="text-entry text-entry--spaced"><input maxLength={160} value={guessText} onFocus={() => activity('guessing_phrase')} onChange={(event) => { setGuessText(event.target.value); setMessage(''); }} placeholder="Напиши свою догадку" /><span>{guessText.length}/160</span></div>{message && <p className="audio-warning">{message}</p>}<button className="button button--primary" disabled={submitting || !guessText.trim()} onClick={() => void submitGuess()}>{submitting ? 'Проверяем…' : 'Ответить'}</button></Screen>}

      {stage === 'watch-guess' && <Screen><div className="permission-icon">👀</div><p className="eyebrow">ИГРОК {responder} УГАДЫВАЕТ · РАУНД {round}</p><h2>Послушай, что получилось у соперника</h2><p className="lead">Мы развернули запись Игрока {responder} обратно. Пока он вводит ответ, ты уже можешь услышать результат.</p><button className="button button--secondary" disabled={playing || !restoredAttempt.current} onClick={() => void play()}>▶ Слушать запись нормально</button>{playbackError && <p className="audio-warning">{playbackError}</p>}<div className="secret-phrase"><span>Ты загадывал</span><strong>{currentRound?.phrase || phraseText}</strong></div><div className="spinner spinner--small" /><p className="privacy-note">Ответ появится здесь автоматически.</p></Screen>}

      {stage === 'audio-error' && <Screen><div className="error-icon">!</div><h2>Запись пока не загрузилась</h2><p className="lead">{playbackError}</p><button className="button button--primary" onClick={() => { const retry = audioRetry.current; if (match && retry) void loadAudio(match.id, retry.number, retry.kind, retry.target); }}>Загрузить ещё раз</button>{currentRound?.status === 'complete' && <button className="button button--ghost" onClick={() => setStage('round-result')}>Показать результат без записи</button>}</Screen>}

      {stage === 'processing' && <Screen><div className="spinner" /><h2>Обрабатываем запись…</h2><p className="lead">{mode === 'local' ? 'Переворачиваем звук прямо на устройстве.' : 'Переворачиваем звук и безопасно передаём следующий ход.'}</p></Screen>}

      {stage === 'round-result' && (mode === 'local' ? <Screen><p className="eyebrow">РАУНД {round} ГОТОВ</p><div className="permission-icon">😄</div><h2>Послушайте, что получилось</h2><p className="lead">Мы развернули повтор Игрока {responder} обратно.</p><button className="button button--secondary" disabled={playing || !restoredAttempt.current} onClick={() => void play()}>▶ Слушать результат</button>{playbackError && <p className="audio-warning">{playbackError}</p>}<button className="button button--primary mode-button" onClick={nextLocalRound}>{round === 1 ? 'Поменяться ролями' : 'Завершить игру'}</button></Screen> : <Screen><p className="eyebrow">РЕЗУЛЬТАТ РАУНДА {round}</p><div className="score-ring"><strong>{resultRow?.score ?? 0}%</strong></div><button className="button button--secondary" disabled={playing || !restoredAttempt.current} onClick={() => void play()}>▶ Слушать запись Игрока {resultRow?.responder} нормально</button>{playbackError && <p className="audio-warning">{playbackError}</p>}<div className="answer-card"><span>Была фраза</span><strong>{resultRow?.phrase}</strong><span>{player === resultRow?.responder ? 'Твой ответ' : `Ответ Игрока ${resultRow?.responder}`}</span><strong>{resultRow?.guess}</strong></div>{message && <p className="audio-warning">{message}</p>}<button className="button button--primary" disabled={submitting} onClick={() => void continueAfterResult()}>{submitting ? 'Продолжаем…' : round === 1 ? 'Продолжить' : 'Общий результат'}</button></Screen>)}

      {stage === 'final' && <div className="screen"><div className="result-head"><p className="eyebrow">{mode === 'remote' ? 'ОНЛАЙН-ДУЭЛЬ ЗАВЕРШЕНА' : 'ИГРА ЗАВЕРШЕНА'}</p><h2>{winner}</h2></div>{mode === 'remote' && <><div className="duel-scores"><div><span>Игрок 1</span><strong>{scores[0] ?? '—'}{scores[0] !== null && '%'}</strong></div><div><span>Игрок 2</span><strong>{scores[1] ?? '—'}{scores[1] !== null && '%'}</strong></div></div><div className="round-answers">{match?.rounds.filter((item) => item.status === 'complete').map((item) => <div className="round-answer" key={item.number}><span>Раунд {item.number} · угадывал Игрок {item.responder}</span><strong>«{item.phrase}»</strong><p>Ответ: «{item.guess}» · {item.score}%</p></div>)}</div></>}{mode === 'local' && <div className="recording-replay"><h3>Послушать ещё раз</h3>{[1, 2].map((number) => <div className="recording-replay__player" key={number}><strong>Игрок {number}</strong><div><button disabled={playing || !originals.current[number - 1]} onClick={() => void playSaved('original', number)}>▶ Что сказал</button><button disabled={playing || !attempts.current[number - 1]} onClick={() => void playSaved('attempt', number)}>▶ Как повторил</button></div></div>)}{playbackError && <p className="audio-warning">{playbackError}</p>}<p>Записи доступны только на этом устройстве до выхода из игры.</p></div>}<button className="button button--secondary" onClick={() => void share()}>Поделиться результатом</button><button className="button button--ghost" onClick={exitFinishedMatch}>Выйти</button><div className="easysong-card"><div className="easysong-card__icon">♫</div><div><h3>А теперь преврати свою идею в песню</h3><p>Создавай песни, картинки, открытки и не только с Сонграйтером / EasySong.</p></div><a className="button button--white" href={API ? `${API}/go/easysong?source=game&campaign=reverse_duel` : 'https://easysong.ru/webapp/auth?next=%2Fwebapp'} onClick={() => track('easysong_clicked')}>Попробовать EasySong →</a></div></div>}

      {stage === 'error' && <Screen><div className="error-icon">!</div><h2>Не получилось</h2><p className="lead">{message}</p><button className="button button--primary" onClick={reset}>В начало</button></Screen>}
    </section>
    {canForfeit && <button className="forfeit-button" onClick={() => void forfeit()}>Выйти из дуэли — сдаться</button>}
    <footer className="footer-note"><span>{mode === 'local' ? 'Одно устройство' : mode === 'remote' ? 'Онлайн-комната' : 'Локально или онлайн'}</span><span>•</span><span>{telegram.isTelegram ? 'Telegram Mini App' : 'Web'}</span></footer>
  </main>;
}

export function liveActivityText(match: DuelMatch | null, viewer: number): string {
  if (!match || match.status === 'waiting_for_player_2') return '';
  const self = match.activity_player === viewer;
  const messages: Record<string, string> = {
    opponent_joined: '✅ Соперник подключился!',
    writing_phrase: self ? '✍️ Ты пишешь секретную фразу…' : '✍️ Соперник придумывает секретную фразу…',
    phrase_ready: self ? '✅ Фраза сохранена. Теперь запиши её.' : '✅ Соперник придумал фразу и готовит запись.',
    recording_challenge: self ? '🎙 Ты записываешь фразу…' : '🎙 Соперник записывает фразу…',
    processing_challenge: '✨ Переворачиваем запись…',
    listening_challenge: self ? '👂 Ты проверяешь задание…' : '👂 Соперник проверяет задание…',
    sending_challenge: self ? '📤 Ты отправляешь задание…' : '📤 Соперник отправляет задание…',
    challenge_ready: match.active_player === viewer ? '🔥 Запись готова! Теперь твоя очередь.' : '🔥 Задание отправлено сопернику.',
    listening_challenge_by_opponent: self ? '👂 Ты слушаешь перевёрнутую запись…' : '👂 Соперник слушает перевёрнутую запись…',
    recording_attempt: self ? '🎤 Ты повторяешь услышанное…' : '🎤 Соперник повторяет услышанное…',
    processing_attempt: '✨ Обрабатываем повтор…',
    sending_attempt: self ? '📤 Ты отправляешь запись…' : '📤 Соперник отправляет запись…',
    listening_restored_attempt: self ? '▶ Ты слушаешь запись в нормальном звучании…' : '▶ Соперник слушает результат…',
    guessing_phrase: self ? '🧠 Ты угадываешь фразу…' : '🧠 Соперник угадывает фразу…',
    switching_roles: '🔄 Раунд завершён. Теперь меняемся ролями.',
    match_finished: '✅ Дуэль завершена.',
  };
  return messages[match.activity_status] || '';
}

function Screen({ children }: { children: ReactNode }) { return <div className="screen screen--center">{children}</div>; }
function Record({ title, subtitle, recording, busy, action }: { title: string; subtitle: string; recording: boolean; busy: boolean; action: () => void }) {
  return <Screen><p className="eyebrow">ЗАПИСЬ</p><h2>{recording ? 'Говори…' : busy ? 'Включаем микрофон…' : title}</h2><p className="lead">{subtitle}</p><div className={recording ? 'waveform waveform--active' : 'waveform'}>{Array.from({ length: 17 }, (_, index) => <span key={index} style={{ '--bar': index } as CSSProperties} />)}</div><button disabled={busy} className={recording ? 'mic-button mic-button--recording' : 'mic-button'} onClick={action}><span>{recording ? '■' : busy ? '…' : '●'}</span></button><strong className="timer">{recording ? 'Нажми, чтобы закончить' : busy ? 'Подожди…' : 'До 8 секунд'}</strong></Screen>;
}
