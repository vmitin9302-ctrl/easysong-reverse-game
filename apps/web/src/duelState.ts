import type { DuelMatch } from './api';

export type RemoteTurnAction = 'cancelled' | 'final' | 'waiting' | 'preserve' | 'permission' | 'record-original' | 'load-challenge' | 'listen' | 'score-attempt';

export function remoteTurnAction(
  match: DuelMatch,
  currentPlayer: number,
  options: { localFlowLocked: boolean; hasMicrophone: boolean; loadedChallengeRound: number | null },
): { action: RemoteTurnAction; round?: number } {
  if (match.status === 'cancelled') return { action: 'cancelled' };
  if (match.status === 'finished' || match.forfeited_by) return { action: 'final' };
  if (match.status === 'waiting_for_player_2') return { action: 'waiting' };
  if (options.localFlowLocked) return { action: 'preserve' };

  const active = match.rounds.find((round) => round.status !== 'complete');
  if (!active) return { action: 'waiting' };
  const round = active.number;

  if (active.challenger === currentPlayer && active.status === 'awaiting_challenge') {
    return { action: options.hasMicrophone ? 'record-original' : 'permission', round };
  }
  if (active.responder === currentPlayer && active.status === 'awaiting_attempt') {
    return { action: options.loadedChallengeRound === round ? 'listen' : 'load-challenge', round };
  }
  if (active.challenger === currentPlayer && active.status === 'awaiting_score') {
    return { action: 'score-attempt', round };
  }
  return { action: 'waiting', round };
}
