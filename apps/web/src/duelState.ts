import type { DuelMatch } from './api';

export type RemoteTurnAction = 'cancelled' | 'final' | 'waiting' | 'preserve' | 'enter-phrase' | 'permission' | 'record-original' | 'load-challenge' | 'listen' | 'load-attempt' | 'guess' | 'watch-guess' | 'round-result';
export type AttemptTarget = 'guess' | 'watch-guess' | 'round-result';

export function remoteTurnAction(
  match: DuelMatch,
  currentPlayer: number,
  options: { localFlowLocked: boolean; hasMicrophone: boolean; loadedChallengeRound: number | null; loadedAttemptRound: number | null },
): { action: RemoteTurnAction; round?: number; attemptTarget?: AttemptTarget } {
  if (match.status === 'cancelled') return { action: 'cancelled' };
  if (match.forfeited_by) return { action: 'final' };

  const unseenResult = match.rounds.find((round) => round.status === 'complete' && !round.result_seen);
  if (unseenResult) {
    if (unseenResult.attempt_available && options.loadedAttemptRound !== unseenResult.number) {
      return { action: 'load-attempt', round: unseenResult.number, attemptTarget: 'round-result' };
    }
    return { action: 'round-result', round: unseenResult.number };
  }
  if (match.status === 'finished') return { action: 'final' };
  if (match.status === 'waiting_for_player_2') return { action: 'waiting' };
  if (options.localFlowLocked) return { action: 'preserve' };

  const active = match.rounds.find((round) => round.status !== 'complete');
  if (!active) return { action: 'waiting' };
  const round = active.number;

  if (active.challenger === currentPlayer && active.status === 'awaiting_phrase') {
    return { action: 'enter-phrase', round };
  }
  if (active.challenger === currentPlayer && active.status === 'awaiting_challenge') {
    return { action: options.hasMicrophone ? 'record-original' : 'permission', round };
  }
  if (active.responder === currentPlayer && active.status === 'awaiting_attempt') {
    return { action: options.loadedChallengeRound === round ? 'listen' : 'load-challenge', round };
  }
  if (active.responder === currentPlayer && active.status === 'awaiting_guess') {
    return options.loadedAttemptRound === round
      ? { action: 'guess', round }
      : { action: 'load-attempt', round, attemptTarget: 'guess' };
  }
  if (active.challenger === currentPlayer && active.status === 'awaiting_guess') {
    return options.loadedAttemptRound === round
      ? { action: 'watch-guess', round }
      : { action: 'load-attempt', round, attemptTarget: 'watch-guess' };
  }
  return { action: 'waiting', round };
}
