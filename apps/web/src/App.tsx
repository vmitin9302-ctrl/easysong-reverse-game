import { useEffect, useMemo, useRef, useState } from 'react';
import { prepareSignal, scoreSignals, type ScoreBreakdown } from '@reverse-game/audio-engine';
import {
  audioBufferToMono,
  createAudioContext,
  decodeRecording,
  playAudioBuffer,
  reverseAudioBuffer,
  selectRecorderMimeType,
} from './audio/browserAudio';
import { initTelegram } from './telegram';
import './styles.css';

type Stage =
  | 'ready'
  | 'permission'
  | 'record-original'
  | 'listen-reversed'
  | 'record-attempt'
  | 'processing'
  | 'result'
  | 'error';

type RetryTarget = 'permission' | 'original' | 'attempt';

type GameError = {
  title: string;
  message: string;
  retry: RetryTarget;
};

type RecordingKind = 'original' | 'attempt';

const MAX_RECORDING_MS = 8_000;
const EASYSONG_FALLBACK = 'https://easysong.ru/webapp/auth?next=%2Fwebapp';

function scoreLabel(score: number): string {
  if (score < 30) return 'Что это сейчас было? 😂';
  if (score < 50) return 'Начало положено';
  if (score < 70) return 'Уже похоже!';
  if (score < 85) return 'Очень близко 🔥';
  if (score < 95) return 'Ты вообще человек?';
  return 'МАСТЕР НАОБОРОТ 👑';
}

function Progress({ step }: { step: number }) {
  return (
    <div className="progress" aria-label={`Шаг ${step} из 3`}>
      {[1, 2, 3].map((item) => (
        <span key={item} className={item <= step ? 'progress__dot progress__dot--active' : 'progress__dot'} />
      ))}
    </div>
  );
}

function Waveform({ active = false }: { active?: boolean }) {
  return (
    <div className={active ? 'waveform waveform--active' : 'waveform'} aria-hidden="true">
      {Array.from({ length: 17 }, (_, index) => (
        <span key={index} style={{ '--bar': index } as React.CSSProperties} />
      ))}
    </div>
  );
}

export default function App() {
  const [stage, setStage] = useState<Stage>('ready');
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [listenCount, setListenCount] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [score, setScore] = useState<ScoreBreakdown | null>(null);
  const [gameError, setGameError] = useState<GameError | null>(null);
  const [telegram] = useState(() => initTelegram());

  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const recordingKindRef = useRef<RecordingKind | null>(null);
  const intervalRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const recordingStartedAtRef = useRef(0);
  const originalRef = useRef<AudioBuffer | null>(null);
  const reversedOriginalRef = useRef<AudioBuffer | null>(null);
  const reconstructedRef = useRef<AudioBuffer | null>(null);

  const source = telegram.isTelegram ? 'telegram' : 'web';
  const easysongHref = useMemo(() => {
    const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '');
    if (apiBase) {
      const params = new URLSearchParams({ source, campaign: 'reverse_game' });
      if (telegram.startParam) params.set('start_param', telegram.startParam);
      return `${apiBase}/go/easysong?${params.toString()}`;
    }
    return (import.meta.env.VITE_EASYSONG_URL as string | undefined) || EASYSONG_FALLBACK;
  }, [source, telegram.startParam]);

  useEffect(() => {
    return () => {
      if (intervalRef.current) window.clearInterval(intervalRef.current);
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      void audioContextRef.current?.close();
    };
  }, []);

  function audioContext(): AudioContext {
    if (!audioContextRef.current) audioContextRef.current = createAudioContext();
    return audioContextRef.current;
  }

  function fail(error: GameError) {
    setIsRecording(false);
    setIsPlaying(false);
    setGameError(error);
    setStage('error');
  }

  async function requestMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      fail({
        title: 'Этот браузер не поддерживает запись',
        message: 'Открой игру в актуальном Chrome, Safari, Edge или внутри Telegram.',
        retry: 'permission',
      });
      return;
    }

    try {
      await audioContext().resume();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = stream;
      setGameError(null);
      setStage('record-original');
    } catch {
      fail({
        title: 'Не получилось включить микрофон',
        message: 'Разреши доступ к микрофону в настройках браузера и попробуй снова.',
        retry: 'permission',
      });
    }
  }

  function clearRecordingTimers() {
    if (intervalRef.current) window.clearInterval(intervalRef.current);
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    intervalRef.current = null;
    timeoutRef.current = null;
  }

  async function processRecording(kind: RecordingKind, blob: Blob) {
    try {
      const context = audioContext();
      const decoded = await decodeRecording(context, blob);
      const mono = audioBufferToMono(decoded);
      const prepared = prepareSignal(mono, decoded.sampleRate);

      if (!prepared) {
        fail({
          title: 'Кажется, я ничего не услышал 😅',
          message: 'Скажи фразу чуть громче и подержи запись хотя бы секунду.',
          retry: kind,
        });
        return;
      }

      if (kind === 'original') {
        originalRef.current = decoded;
        reversedOriginalRef.current = reverseAudioBuffer(context, decoded);
        setListenCount(0);
        setStage('listen-reversed');
        return;
      }

      setStage('processing');
      const reconstructed = reverseAudioBuffer(context, decoded);
      reconstructedRef.current = reconstructed;
      await new Promise((resolve) => window.setTimeout(resolve, 80));

      const original = originalRef.current;
      if (!original) throw new Error('Original recording is missing');

      const result = scoreSignals(
        audioBufferToMono(original),
        original.sampleRate,
        audioBufferToMono(reconstructed),
        reconstructed.sampleRate,
      );

      if (!result) {
        fail({
          title: 'Не получилось сравнить записи',
          message: 'Попробуй повторить услышанное ещё раз и говори чуть громче.',
          retry: 'attempt',
        });
        return;
      }

      setScore(result);
      setStage('result');
    } catch {
      fail({
        title: 'Что-то пошло не так',
        message: 'Не удалось обработать запись. Запишем ещё раз?',
        retry: kind,
      });
    }
  }

  function startRecording(kind: RecordingKind) {
    const stream = streamRef.current;
    if (!stream) {
      setStage('permission');
      return;
    }

    try {
      const mimeType = selectRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      recordingKindRef.current = kind;
      recorderRef.current = recorder;

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      });

      recorder.addEventListener(
        'stop',
        () => {
          clearRecordingTimers();
          setIsRecording(false);
          const recordingKind = recordingKindRef.current;
          recordingKindRef.current = null;
          const blob = new Blob(chunksRef.current, {
            type: recorder.mimeType || mimeType || 'audio/webm',
          });
          if (recordingKind) void processRecording(recordingKind, blob);
        },
        { once: true },
      );

      recordingStartedAtRef.current = performance.now();
      setElapsedMs(0);
      setIsRecording(true);
      recorder.start(100);

      intervalRef.current = window.setInterval(() => {
        setElapsedMs(performance.now() - recordingStartedAtRef.current);
      }, 50);
      timeoutRef.current = window.setTimeout(() => stopRecording(), MAX_RECORDING_MS);
    } catch {
      fail({
        title: 'Не удалось начать запись',
        message: 'Проверь микрофон и попробуй снова.',
        retry: kind,
      });
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }

  async function play(buffer: AudioBuffer | null, countListen = false) {
    if (!buffer || isPlaying) return;
    try {
      setIsPlaying(true);
      await playAudioBuffer(audioContext(), buffer);
      if (countListen) setListenCount((value) => Math.min(3, value + 1));
    } finally {
      setIsPlaying(false);
    }
  }

  function resetRound() {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    clearRecordingTimers();
    originalRef.current = null;
    reversedOriginalRef.current = null;
    reconstructedRef.current = null;
    setScore(null);
    setGameError(null);
    setListenCount(0);
    setElapsedMs(0);
    setIsRecording(false);
    setStage(streamRef.current ? 'record-original' : 'permission');
  }

  function retryAfterError() {
    if (!gameError) return;
    setGameError(null);
    if (gameError.retry === 'permission') {
      setStage('permission');
      return;
    }
    setStage(gameError.retry === 'original' ? 'record-original' : 'record-attempt');
  }

  async function shareResult() {
    const value = score?.score ?? 0;
    const text = `Я набрал ${value}% в «Скажи наоборот» 😈 Сможешь лучше?`;
    const shareData = { title: 'Скажи наоборот', text, url: window.location.href };

    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch {
        return;
      }
    }

    await navigator.clipboard?.writeText(`${text} ${window.location.href}`);
    window.alert('Ссылка на игру скопирована');
  }

  const seconds = Math.min(8, elapsedMs / 1000).toFixed(1);

  return (
    <main className="app-shell">
      <header className="brandbar">
        <div className="brandmark">S</div>
        <div>
          <strong>Сонграйтер</strong>
          <span>мини-игра</span>
        </div>
        <div className="brandbar__pill">β</div>
      </header>

      <section className="game-card">
        {stage === 'ready' && (
          <div className="screen screen--center">
            <div className="hero-icon" aria-hidden="true">↶</div>
            <p className="eyebrow">ГОЛОСОВОЙ ЧЕЛЛЕНДЖ</p>
            <h1>Сможешь говорить<br />задом наперёд?</h1>
            <p className="lead">Запиши фразу, послушай её наоборот и попробуй повторить.</p>
            <button className="button button--primary" onClick={() => setStage('permission')}>
              🎙 Начать игру
            </button>
            <p className="privacy-note">Без регистрации · аудио остаётся на устройстве</p>
          </div>
        )}

        {stage === 'permission' && (
          <div className="screen screen--center">
            <Progress step={1} />
            <div className="permission-icon" aria-hidden="true">🎙</div>
            <h2>Для игры понадобится микрофон</h2>
            <p className="lead">Записи обрабатываются прямо на твоём устройстве и не сохраняются на сервере.</p>
            <button className="button button--primary" onClick={() => void requestMicrophone()}>
              Разрешить микрофон
            </button>
            <button className="button button--ghost" onClick={() => setStage('ready')}>Назад</button>
          </div>
        )}

        {stage === 'record-original' && (
          <div className="screen screen--center">
            <Progress step={1} />
            <p className="eyebrow">ШАГ 1 ИЗ 3</p>
            <h2>{isRecording ? 'Говори…' : 'Скажи любую короткую фразу'}</h2>
            <p className="lead">Лучше 2–6 секунд. Например: «Сегодня я запишу хит».</p>
            <Waveform active={isRecording} />
            <button
              className={isRecording ? 'mic-button mic-button--recording' : 'mic-button'}
              onClick={() => (isRecording ? stopRecording() : startRecording('original'))}
              aria-label={isRecording ? 'Остановить запись' : 'Начать запись'}
            >
              <span>{isRecording ? '■' : '●'}</span>
            </button>
            <strong className="timer">{isRecording ? `${seconds} / 8.0 сек` : 'Нажми и скажи фразу'}</strong>
          </div>
        )}

        {stage === 'listen-reversed' && (
          <div className="screen screen--center">
            <Progress step={2} />
            <p className="eyebrow">ШАГ 2 ИЗ 3</p>
            <h2>А теперь слушай внимательно 👀</h2>
            <p className="lead">Запомни, как звучит твоя фраза задом наперёд.</p>
            <div className="audio-orb" aria-hidden="true">◀︎</div>
            <button
              className="button button--secondary"
              disabled={isPlaying || listenCount >= 3}
              onClick={() => void play(reversedOriginalRef.current, true)}
            >
              {isPlaying ? 'Слушаем…' : listenCount >= 3 ? 'Прослушано 3 раза' : '▶ Слушать наоборот'}
            </button>
            <p className="counter">Прослушиваний: {listenCount}/3</p>
            <button className="button button--primary" onClick={() => setStage('record-attempt')}>
              🎙 Теперь повторить
            </button>
          </div>
        )}

        {stage === 'record-attempt' && (
          <div className="screen screen--center">
            <Progress step={3} />
            <p className="eyebrow">ШАГ 3 ИЗ 3</p>
            <h2>{isRecording ? 'Повторяй…' : 'Повтори то, что услышал'}</h2>
            <p className="lead">Постарайся повторить странные звуки максимально похоже.</p>
            <Waveform active={isRecording} />
            <button
              className={isRecording ? 'mic-button mic-button--recording' : 'mic-button'}
              onClick={() => (isRecording ? stopRecording() : startRecording('attempt'))}
              aria-label={isRecording ? 'Остановить запись' : 'Начать попытку'}
            >
              <span>{isRecording ? '■' : '●'}</span>
            </button>
            <strong className="timer">{isRecording ? `${seconds} / 8.0 сек` : 'Готов? Нажимай'}</strong>
            {!isRecording && (
              <button className="button button--ghost" onClick={() => setStage('listen-reversed')}>
                Послушать ещё раз
              </button>
            )}
          </div>
        )}

        {stage === 'processing' && (
          <div className="screen screen--center processing-screen">
            <div className="spinner" aria-hidden="true" />
            <h2>Проверяем…</h2>
            <p className="lead">Переворачиваем твою попытку обратно и сравниваем звук.</p>
          </div>
        )}

        {stage === 'result' && score && (
          <div className="screen">
            <div className="result-head">
              <p className="eyebrow">ТВОЙ РЕЗУЛЬТАТ</p>
              <div className="score-ring"><strong>{score.score}%</strong></div>
              <h2>{scoreLabel(score.score)}</h2>
              <p className="lead">Сравни, насколько похоже получилось после обратного переворота.</p>
            </div>

            <div className="listen-grid">
              <button className="audio-button" disabled={isPlaying} onClick={() => void play(originalRef.current)}>
                <span>▶</span><div><small>Послушать</small><strong>Оригинал</strong></div>
              </button>
              <button className="audio-button" disabled={isPlaying} onClick={() => void play(reconstructedRef.current)}>
                <span>▶</span><div><small>Послушать</small><strong>Что получилось</strong></div>
              </button>
            </div>

            <div className="result-actions">
              <button className="button button--secondary" onClick={() => void shareResult()}>😈 Бросить вызов другу</button>
              <button className="button button--ghost" onClick={resetRound}>Сыграть ещё раз</button>
            </div>

            <div className="easysong-card">
              <div className="easysong-card__icon">♫</div>
              <div>
                <h3>С голосом разобрались</h3>
                <p>А теперь преврати свою идею в настоящую песню с Сонграйтером.</p>
              </div>
              <a className="button button--white" href={easysongHref}>Создать свою песню →</a>
            </div>

            <details className="score-details">
              <summary>Как считается результат?</summary>
              <p>Локальный алгоритм сравнивает акустическую структуру, ритм и длительность. Это игровой показатель сходства, а не медицинская или научная оценка речи.</p>
            </details>
          </div>
        )}

        {stage === 'error' && gameError && (
          <div className="screen screen--center">
            <div className="error-icon" aria-hidden="true">!</div>
            <h2>{gameError.title}</h2>
            <p className="lead">{gameError.message}</p>
            <button className="button button--primary" onClick={retryAfterError}>Попробовать снова</button>
            <button className="button button--ghost" onClick={resetRound}>Начать заново</button>
          </div>
        )}
      </section>

      <footer className="footer-note">
        <span>Аудио не загружается на сервер</span>
        <span>•</span>
        <span>{telegram.isTelegram ? 'Telegram Mini App' : 'Web'}</span>
      </footer>
    </main>
  );
}
