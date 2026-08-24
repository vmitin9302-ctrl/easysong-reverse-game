import { describe, expect, it } from 'vitest';
import type { DuelMatch, DuelRound } from './api';
import { remoteTurnAction } from './duelState';
import { liveActivityText } from './App';

function match(status: string, activeStatus: string, challenger = 1, responder = 2): DuelMatch {
  const rounds: DuelRound[] = [
    { number: 1, challenger, responder, status: activeStatus, score: null },
    { number: 2, challenger: 2, responder: 1, status: 'awaiting_challenge', score: null },
  ];
  return { id: 'match', invite_token: 'invite', player: 1, status, rounds, current_round: 1, active_player: challenger, revision: 1, updated_at: '', activity_status: 'opponent_joined', activity_player: null, activity_updated_at: null, player_one_last_seen_at: null, player_two_last_seen_at: null, invite_expires_at: null, rematch_requested_by: null, scores: [null, null], winner: null };
}

describe('remoteTurnAction', () => {
  it('preserves recording and review screens while the server still reports awaiting challenge', () => {
    const decision = remoteTurnAction(match('round_1', 'awaiting_challenge'), 1, {
      localFlowLocked: true,
      hasMicrophone: false,
      loadedChallengeRound: null,
    });
    expect(decision.action).toBe('preserve');
  });

  it('opens recording after the active challenger grants microphone permission', () => {
    const decision = remoteTurnAction(match('round_1', 'awaiting_challenge'), 1, {
      localFlowLocked: false,
      hasMicrophone: true,
      loadedChallengeRound: null,
    });
    expect(decision).toEqual({ action: 'record-original', round: 1 });
  });

  it('does not request a microphone from the responder before the challenge exists', () => {
    const decision = remoteTurnAction(match('round_1', 'awaiting_challenge'), 2, {
      localFlowLocked: false,
      hasMicrophone: false,
      loadedChallengeRound: null,
    });
    expect(decision.action).toBe('waiting');
  });

  it('loads a challenge once and then keeps the listen screen', () => {
    const active = match('round_1', 'awaiting_attempt');
    expect(remoteTurnAction(active, 2, { localFlowLocked: false, hasMicrophone: false, loadedChallengeRound: null }).action).toBe('load-challenge');
    expect(remoteTurnAction(active, 2, { localFlowLocked: false, hasMicrophone: false, loadedChallengeRound: 1 }).action).toBe('listen');
  });

  it('preserves the responder recording while the server still reports awaiting attempt', () => {
    const decision = remoteTurnAction(match('round_1', 'awaiting_attempt'), 2, {
      localFlowLocked: true,
      hasMicrophone: true,
      loadedChallengeRound: 1,
    });
    expect(decision.action).toBe('preserve');
  });

  it('starts scoring once and preserves the screen while scoring is already running', () => {
    const active = match('round_1', 'awaiting_score');
    expect(remoteTurnAction(active, 1, { localFlowLocked: false, hasMicrophone: false, loadedChallengeRound: null }).action).toBe('score-attempt');
    expect(remoteTurnAction(active, 1, { localFlowLocked: true, hasMicrophone: false, loadedChallengeRound: null }).action).toBe('preserve');
  });

  it('lets a remote terminal state override a locked local audio step', () => {
    const forfeited = { ...match('forfeited_by_2', 'awaiting_attempt'), forfeited_by: 2 };
    const decision = remoteTurnAction(forfeited, 1, {
      localFlowLocked: true,
      hasMicrophone: true,
      loadedChallengeRound: 1,
    });
    expect(decision.action).toBe('final');
  });
});

describe('liveActivityText', () => {
  it('describes browser and Telegram players symmetrically from the viewer perspective', () => {
    const state = { ...match('round_1', 'awaiting_challenge'), activity_status: 'recording_challenge', activity_player: 1 };
    expect(liveActivityText(state, 1)).toContain('Ты записываешь');
    expect(liveActivityText(state, 2)).toContain('Соперник записывает');
  });

  it('announces the turn after the challenge becomes ready', () => {
    const state = { ...match('round_1', 'awaiting_attempt'), active_player: 2, activity_status: 'challenge_ready', activity_player: 1 };
    expect(liveActivityText(state, 2)).toContain('Теперь твоя очередь');
  });
});
