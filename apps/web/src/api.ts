import type { ScoreBreakdown } from '@reverse-game/audio-engine';

const baseUrl = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || '').replace(/\/$/, '');
const ANONYMOUS_ID_KEY = 'reverse_game_anonymous_id';

export const hasApi = Boolean(baseUrl);

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  const abort = () => controller.abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      credentials: 'include',
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

export type DuelRound = { number: number; challenger: number; responder: number; status: string; phrase: string | null; guess: string | null; score: number | null; audio_expires_at?: string | null; attempt_available: boolean; result_seen: boolean };
export type DuelMatch = { id: string; invite_token: string; player: number; status: string; rounds: DuelRound[]; forfeited_by?: number | null; player_token?: string; current_round: number; active_player: number; revision: number; updated_at: string; activity_status: string; activity_player: number | null; activity_updated_at: string | null; player_one_last_seen_at: string | null; player_two_last_seen_at: string | null; invite_expires_at: string | null; rematch_requested_by: number | null; scores: [number | null, number | null]; winner: number | null };

const memoryIdempotencyKeys = new Map<string, string>();

function idempotencyKey(storageKey: string): string {
  try {
    const saved = sessionStorage.getItem(storageKey);
    if (saved) return saved;
  } catch { /* Restricted WebViews may disable sessionStorage. */ }
  const generated = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  memoryIdempotencyKeys.set(storageKey, generated);
  try { sessionStorage.setItem(storageKey, generated); } catch { /* Keep the in-memory fallback. */ }
  return generated;
}

function forgetIdempotencyKey(storageKey: string): void {
  memoryIdempotencyKeys.delete(storageKey);
  try { sessionStorage.removeItem(storageKey); } catch { /* Nothing else to clean. */ }
}

function playerRequest<T>(path: string, playerToken: string, init: RequestInit = {}): Promise<T> {
  return request<T>(path, { ...init, headers: { ...(init.headers || {}), 'X-Player-Token': playerToken } });
}

export async function createDuelMatch(sessionId: string | null): Promise<DuelMatch> {
  return request('/v1/matches', { method: 'POST', body: JSON.stringify({ session_id: sessionId }) });
}
export async function joinDuelMatch(inviteToken: string, participantToken?: string): Promise<DuelMatch> {
  return request(`/v1/matches/join/${encodeURIComponent(inviteToken)}`, { method: 'POST', body: JSON.stringify({ participant_token: participantToken || null }) });
}
export async function getDuelMatch(id: string, token: string): Promise<DuelMatch> {
  return playerRequest(`/v1/matches/${id}`, token);
}
export async function cancelDuelMatch(id: string, token: string): Promise<void> {
  await playerRequest(`/v1/matches/${id}/cancel`, token, { method: 'POST', body: '{}' });
}
export async function forfeitDuelMatch(id: string, token: string): Promise<DuelMatch> {
  return playerRequest(`/v1/matches/${id}/forfeit`, token, { method: 'POST', body: '{}' });
}
export async function heartbeatDuelMatch(id: string, token: string): Promise<void> {
  await playerRequest(`/v1/matches/${id}/heartbeat`, token, { method: 'POST', body: '{}' });
}
export async function updateDuelActivity(id: string, token: string, status: string): Promise<void> {
  await playerRequest(`/v1/matches/${id}/activity`, token, { method: 'POST', body: JSON.stringify({ status }) });
}
export async function submitRoundPhrase(id: string, round: number, token: string, phrase: string): Promise<DuelMatch> {
  return playerRequest(`/v1/matches/${id}/rounds/${round}/phrase`, token, { method: 'POST', body: JSON.stringify({ phrase }) });
}
export async function uploadRoundAudio(id: string, round: number, kind: 'challenge' | 'attempt', token: string, blob: Blob): Promise<void> {
  const storageKey = `reverse_duel_idem_${id}_${round}_${kind}`;
  const requestKey = memoryIdempotencyKeys.get(storageKey) || idempotencyKey(storageKey);
  const result = await playerRequest<{ upload_url: string }>(`/v1/matches/${id}/rounds/${round}/${kind}-upload`, token, { method: 'POST', body: JSON.stringify({ content_type: blob.type, idempotency_key: requestKey }) });
  const uploaded = await fetch(result.upload_url, { method: 'PUT', headers: { 'Content-Type': blob.type }, body: blob });
  if (!uploaded.ok) throw new Error('Audio upload failed');
  await playerRequest(`/v1/matches/${id}/rounds/${round}/${kind}-ready`, token, { method: 'POST', body: '{}' });
  forgetIdempotencyKey(storageKey);
}
export async function downloadRoundAudio(id: string, round: number, kind: 'challenge' | 'attempt', token: string): Promise<Blob> {
  const result = await playerRequest<{ download_url: string }>(`/v1/matches/${id}/rounds/${round}/${kind}-audio`, token);
  const response = await fetch(result.download_url); if (!response.ok) throw new Error('Audio download failed'); return response.blob();
}
export async function submitRoundGuess(id: string, round: number, token: string, guess: string): Promise<DuelMatch> {
  return playerRequest(`/v1/matches/${id}/rounds/${round}/guess`, token, { method: 'POST', body: JSON.stringify({ guess }) });
}
export async function markRoundResultSeen(id: string, round: number, token: string): Promise<DuelMatch> {
  return playerRequest(`/v1/matches/${id}/rounds/${round}/result-seen`, token, { method: 'POST', body: '{}' });
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
  medium?: string;
  referralToken?: string;
}): Promise<string | null> {
  if (!hasApi) return null;
  const result = await request<{ id: string }>('/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({
      source: input.source,
      platform: input.platform,
      campaign: input.campaign,
      medium: input.medium,
      referral_token: input.referralToken,
    }),
  });
  return result.id;
}

export type AnalyticsReport = {
  period_days: number;
  totals: Record<string, number>;
  events: Record<string, number>;
  top_elements: { element: string; clicks: number }[];
  daily: Record<string, Record<string, number>>;
};

export async function adminLogin(username: string, password: string): Promise<string> {
  const result = await request<{ session_token: string }>('/v1/admin/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  return result.session_token;
}

export async function adminLogout(): Promise<void> {
  await request('/v1/admin/logout', { method: 'POST', body: '{}' });
}

export async function getAnalytics(days: number, sessionToken?: string): Promise<AnalyticsReport> {
  return request(`/v1/admin/analytics?days=${days}`, {
    method: 'GET', headers: sessionToken ? { 'X-Admin-Session': sessionToken } : undefined,
  });
}

export function anonymousId(): string {
  try {
    const saved = localStorage.getItem(ANONYMOUS_ID_KEY);
    if (saved) return saved;
    const generated = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(ANONYMOUS_ID_KEY, generated);
    return generated;
  } catch {
    return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
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
  const { page, section, element, action, source, ...safeProperties } = properties;
  const event = {
    session_id: sessionId,
    event_name: eventName,
    page: typeof page === 'string' ? page : location.pathname,
    section: typeof section === 'string' ? section : undefined,
    element: typeof element === 'string' ? element : undefined,
    action: typeof action === 'string' ? action : undefined,
    source: typeof source === 'string' ? source : undefined,
    anonymous_id: anonymousId(),
    properties: safeProperties,
  };
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
