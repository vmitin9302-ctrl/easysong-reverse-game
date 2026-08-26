import { describe, expect, it } from 'vitest';
import type { DuelMatch, DuelRound } from './api';
import { remoteTurnAction } from './duelState';
import { liveActivityText } from './App';

function match(status: string, activeStatus: string, challenger = 1, responder = 2): DuelMatch {
  const rounds: DuelRound[] = [
    { number: 1, challenger, responder, status: activeStatus, phrase: null, guess: null, score: null, attempt_available: activeStatus === 'awaiting_guess', result_seen: false },
    { number: 2, challenger: 2, responder: 1, status: 'awaiting_phrase', phrase: null, guess: null, score: null, attempt_available: false, result_seen: false },
  ];
  return { id: 'match', invite_token: 'invite', player: 1, status, rounds, current_round: 1, active_player: challenger, revision: 1, updated_at: '', activity_status: 'opponent_joined', activity_player: null, activity_updated_at: null, player_one_last_seen_at: null, player_two_last_seen_at: null, invite_expires_at: null, rematch_requested_by: null, scores: [null, null], winner: null };
}

describe('remoteTurnAction', () => {
  it('preserves recording and review screens while the server still reports awaiting challenge', () => {
    const decision = remoteTurnAction(match('round_1', 'awaiting_challenge'), 1, {
      localFlowLocked: true,
      hasMicrophone: false,
      loadedChallengeRound: null, loadedAttemptRound: null,
    });
    expect(decision.action).toBe('preserve');
  });

  it('asks the challenger for a phrase before recording', () => {
    const decision = remoteTurnAction(match('round_1', 'awaiting_phrase'), 1, {
      localFlowLocked: false,
      hasMicrophone: false,
      loadedChallengeRound: null,
      loadedAttemptRound: null,
    });
    expect(decision).toEqual({ action: 'enter-phrase', round: 1 });
  });

  it('opens recording after the phrase is ready and microphone is granted', () => {
    const decision = remoteTurnAction(match('round_1', 'awaiting_challenge'), 1, {
      localFlowLocked: false,
      hasMicrophone: true,
      loadedChallengeRound: null, loadedAttemptRound: null,
    });
    expect(decision).toEqual({ action: 'record-original', round: 1 });
  });

  it('does not request a microphone from the responder before the challenge exists', () => {
    const decision = remoteTurnAction(match('round_1', 'awaiting_challenge'), 2, {
      localFlowLocked: false,
      hasMicrophone: false,
      loadedChallengeRound: null, loadedAttemptRound: null,
    });
    expect(decision.action).toBe('waiting');
  });

  it('loads a challenge once and then keeps the listen screen', () => {
    const active = match('round_1', 'awaiting_attempt');
    expect(remoteTurnAction(active, 2, { localFlowLocked: false, hasMicrophone: false, loadedChallengeRound: null, loadedAttemptRound: null }).action).toBe('load-challenge');
    expect(remoteTurnAction(active, 2, { localFlowLocked: false, hasMicrophone: false, loadedChallengeRound: 1, loadedAttemptRound: null }).action).toBe('listen');
  });

  it('preserves the responder recording while the server still reports awaiting attempt', () => {
    const decision = remoteTurnAction(match('round_1', 'awaiting_attempt'), 2, {
      localFlowLocked: true,
      hasMicrophone: true,
      loadedChallengeRound: 1, loadedAttemptRound: null,
    });
    expect(decision.action).toBe('preserve');
  });

  it('restores the responder attempt before asking for a text guess', () => {
    const active = match('round_1', 'awaiting_guess');
    expect(remoteTurnAction(active, 2, { localFlowLocked: false, hasMicrophone: false, loadedChallengeRound: 1, loadedAttemptRound: null })).toEqual({ action: 'load-attempt', round: 1, attemptTarget: 'guess' });
    expect(remoteTurnAction(active, 2, { localFlowLocked: false, hasMicrophone: false, loadedChallengeRound: 1, loadedAttemptRound: 1 }).action).toBe('guess');
  });

  it('lets the challenger hear the restored attempt while the responder guesses', () => {
    const active = match('round_1', 'awaiting_guess');
    expect(remoteTurnAction(active, 1, { localFlowLocked: false, hasMicrophone: false, loadedChallengeRound: null, loadedAttemptRound: null })).toEqual({ action: 'load-attempt', round: 1, attemptTarget: 'watch-guess' });
    expect(remoteTurnAction(active, 1, { localFlowLocked: false, hasMicrophone: false, loadedChallengeRound: null, loadedAttemptRound: 1 })).toEqual({ action: 'watch-guess', round: 1 });
  });

  it('shows every completed round to both players before advancing or finishing', () => {
    const completed = match('round_2', 'complete');
    completed.rounds[0] = { ...completed.rounds[0], phrase: 'секрет', guess: 'ответ', score: 80, attempt_available: true, result_seen: false };
    expect(remoteTurnAction(completed, 1, { localFlowLocked: false, hasMicrophone: false, loadedChallengeRound: null, loadedAttemptRound: null })).toEqual({ action: 'load-attempt', round: 1, attemptTarget: 'round-result' });
    expect(remoteTurnAction(completed, 1, { localFlowLocked: false, hasMicrophone: false, loadedChallengeRound: null, loadedAttemptRound: 1 })).toEqual({ action: 'round-result', round: 1 });
    completed.rounds[0].result_seen = true;
    expect(remoteTurnAction(completed, 1, { localFlowLocked: false, hasMicrophone: false, loadedChallengeRound: null, loadedAttemptRound: null }).action).toBe('waiting');
  });

  it('shows the second-round result before the final screen', () => {
    const finished = match('finished', 'complete');
    finished.rounds[0].result_seen = true;
    finished.rounds[1] = { ...finished.rounds[1], status: 'complete', phrase: 'финал', guess: 'ответ', score: 70, attempt_available: true, result_seen: false };
    expect(remoteTurnAction(finished, 1, { localFlowLocked: false, hasMicrophone: false, loadedChallengeRound: null, loadedAttemptRound: 2 })).toEqual({ action: 'round-result', round: 2 });
    finished.rounds[1].result_seen = true;
    expect(remoteTurnAction(finished, 1, { localFlowLocked: false, hasMicrophone: false, loadedChallengeRound: null, loadedAttemptRound: null }).action).toBe('final');
  });

  it('lets a remote terminal state override a locked audio step', () => {
    const forfeited = { ...match('forfeited_by_2', 'awaiting_attempt'), forfeited_by: 2 };
    const decision = remoteTurnAction(forfeited, 1, {
      localFlowLocked: true,
      hasMicrophone: true,
      loadedChallengeRound: 1, loadedAttemptRound: null,
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
