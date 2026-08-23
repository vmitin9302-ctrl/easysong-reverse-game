import type { ScoreBreakdown } from '@reverse-game/audio-engine';

const baseUrl = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || '').replace(/\/$/, '');

export const hasApi = Boolean(baseUrl);

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  const abort = () => controller.abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    if (!response.ok) throw new Error(`API ${response.status}`);
    return response.json() as Promise<T>;
  } catch (error) {
    if (controller.signal.aborted && !init.signal?.aborted) throw new Error('API timeout');
    throw error;
  } finally {
    window.clearTimeout(timeout);
    init.signal?.removeEventListener('abort', abort);
  }
}

export type DuelRound = { number: number; challenger: number; responder: number; status: string; score: number | null };
export type DuelMatch = { id: string; invite_token: string; player: number; status: string; rounds: DuelRound[]; player_token?: string };

function playerRequest<T>(path: string, playerToken: string, init: RequestInit = {}): Promise<T> {
  return request<T>(path, { ...init, headers: { ...(init.headers || {}), 'X-Player-Token': playerToken } });
}

export async function createDuelMatch(sessionId: string | null): Promise<DuelMatch> {
  return request('/v1/matches', { method: 'POST', body: JSON.stringify({ session_id: sessionId }) });
}
export async function joinDuelMatch(inviteToken: string): Promise<DuelMatch> {
  return request(`/v1/matches/join/${encodeURIComponent(inviteToken)}`, { method: 'POST', body: '{}' });
}
export async function getDuelMatch(id: string, token: string): Promise<DuelMatch> {
  return playerRequest(`/v1/matches/${id}`, token);
}
export async function uploadRoundAudio(id: string, round: number, kind: 'challenge' | 'attempt', token: string, blob: Blob): Promise<void> {
  const result = await playerRequest<{ upload_url: string }>(`/v1/matches/${id}/rounds/${round}/${kind}-upload`, token, { method: 'POST', body: JSON.stringify({ content_type: blob.type }) });
  const uploaded = await fetch(result.upload_url, { method: 'PUT', headers: { 'Content-Type': blob.type }, body: blob });
  if (!uploaded.ok) throw new Error('Audio upload failed');
  await playerRequest(`/v1/matches/${id}/rounds/${round}/${kind}-ready`, token, { method: 'POST', body: '{}' });
}
export async function downloadRoundAudio(id: string, round: number, kind: 'challenge' | 'attempt', token: string): Promise<Blob> {
  const result = await playerRequest<{ download_url: string }>(`/v1/matches/${id}/rounds/${round}/${kind}-audio`, token);
  const response = await fetch(result.download_url); if (!response.ok) throw new Error('Audio download failed'); return response.blob();
}
export async function submitRoundScore(id: string, round: number, token: string, score: ScoreBreakdown): Promise<DuelMatch> {
  return playerRequest(`/v1/matches/${id}/rounds/${round}/score`, token, { method: 'POST', body: JSON.stringify({ score: score.score, acoustic_similarity: score.acousticSimilarity, rhythm_similarity: score.rhythmSimilarity, duration_similarity: score.durationSimilarity }) });
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
