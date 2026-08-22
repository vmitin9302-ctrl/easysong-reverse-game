import type { ScoreBreakdown } from '@reverse-game/audio-engine';

const baseUrl = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || '').replace(/\/$/, '');

export const hasApi = Boolean(baseUrl);

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`API ${response.status}`);
  return response.json() as Promise<T>;
}

export async function authenticateTelegram(initData: string): Promise<boolean> {
  if (!hasApi || !initData) return false;
  const result = await request<{ valid: boolean }>('/v1/auth/telegram', {
    method: 'POST',
    body: JSON.stringify({ init_data: initData }),
  });
  return result.valid;
}

export async function createGameSession(input: {
  source: string;
  platform: string;
  campaign?: string;
  referralToken?: string;
}): Promise<string | null> {
  if (!hasApi) return null;
  const result = await request<{ id: string }>('/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({
      source: input.source,
      platform: input.platform,
      campaign: input.campaign,
      referral_token: input.referralToken,
    }),
  });
  return result.id;
}

function queueEvent(event: unknown) {
  try {
    const queue = JSON.parse(localStorage.getItem('reverse_game_event_queue') || '[]') as unknown[];
    queue.push(event);
    localStorage.setItem('reverse_game_event_queue', JSON.stringify(queue.slice(-50)));
  } catch {
    // Private browsing/storage restrictions must never break the game.
  }
}

export async function trackEvent(
  sessionId: string | null,
  eventName: string,
  properties: Record<string, unknown> = {},
): Promise<void> {
  if (!hasApi) return;
  const event = { session_id: sessionId, event_name: eventName, properties };
  try {
    await request('/v1/events', {
      method: 'POST',
      body: JSON.stringify(event),
    });
  } catch {
    queueEvent(event);
  }
}

export async function flushEventQueue(): Promise<void> {
  if (!hasApi) return;
  try {
    const raw = localStorage.getItem('reverse_game_event_queue');
    if (!raw) return;
    const events = JSON.parse(raw) as unknown[];
    if (!events.length) return;
    await request('/v1/events/batch', {
      method: 'POST',
      body: JSON.stringify({ events }),
    });
    localStorage.removeItem('reverse_game_event_queue');
  } catch {
    // Keep the queue for the next online attempt.
  }
}

export async function saveGameResult(
  sessionId: string | null,
  score: ScoreBreakdown,
  originalDurationMs: number,
  attemptDurationMs: number,
): Promise<void> {
  if (!hasApi || !sessionId) return;
  await request(`/v1/sessions/${sessionId}/result`, {
    method: 'POST',
    body: JSON.stringify({
      score: score.score,
      original_duration_ms: Math.round(originalDurationMs),
      attempt_duration_ms: Math.round(attemptDurationMs),
      acoustic_similarity: score.acousticSimilarity,
      rhythm_similarity: score.rhythmSimilarity,
      duration_similarity: score.durationSimilarity,
    }),
  });
}

export async function createShareLink(sessionId: string | null, score: number): Promise<string | null> {
  if (!hasApi || !sessionId) return null;
  const result = await request<{ token: string }>('/v1/shares', {
    method: 'POST',
    body: JSON.stringify({ creator_session_id: sessionId, score }),
  });
  return result.token;
}
