// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import * as api from './api';

vi.mock('./api', async (original) => ({
  ...await original<typeof import('./api')>(),
  createGameSession: vi.fn().mockResolvedValue(null),
  trackEvent: vi.fn().mockResolvedValue(undefined),
  getDuelMatch: vi.fn(),
  heartbeatDuelMatch: vi.fn().mockResolvedValue(undefined),
  updateDuelActivity: vi.fn().mockResolvedValue(undefined),
}));

const saved = { id: 'match', token: 'participant-token', expiresAt: Date.now() + 86400000 };
const snapshot = {
  id: 'match', player: 1, invite_token: 'invite', status: 'round_1', revision: 2,
  current_round: 1, active_player: 1, scores: [null, null],
  rounds: [{ number: 1, challenger: 1, responder: 2, status: 'awaiting_phrase', phrase: null }],
} as api.DuelMatch;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.setItem('reverse_duel_remote_session', JSON.stringify(saved));
  vi.mocked(api.getDuelMatch).mockResolvedValue(snapshot);
});
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); vi.clearAllMocks(); });

it('preserves a typed phrase across heartbeat revisions and sends no overlapping polls', async () => {
  await act(async () => { render(<App />); });
  const input = screen.getByPlaceholderText('Например: сегодня отличный день');
  fireEvent.change(input, { target: { value: 'Сегодня отличный день' } });
  vi.mocked(api.getDuelMatch).mockResolvedValue({ ...snapshot, revision: 3 });
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect((input as HTMLInputElement).value).toBe('Сегодня отличный день');
  expect((screen.getByText('Сохранить и записать') as HTMLButtonElement).disabled).toBe(false);
  vi.mocked(api.getDuelMatch).mockImplementation(() => new Promise(() => {}));
  const count = vi.mocked(api.getDuelMatch).mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(vi.mocked(api.getDuelMatch).mock.calls.length - count).toBe(1);
});

it('retains the participant token when restoring during an outage', async () => {
  vi.mocked(api.getDuelMatch).mockRejectedValue(new TypeError('Failed to fetch'));
  await act(async () => { render(<App />); });
  expect(JSON.parse(localStorage.getItem('reverse_duel_remote_session')!).token).toBe(saved.token);
  expect(screen.getByText(/место игрока сохранено/)).toBeTruthy();
});
