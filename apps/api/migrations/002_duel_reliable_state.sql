ALTER TABLE duel_matches ADD COLUMN IF NOT EXISTS current_round SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE duel_matches ADD COLUMN IF NOT EXISTS active_player SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE duel_matches ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE duel_matches ADD COLUMN IF NOT EXISTS activity_status VARCHAR(48) NOT NULL DEFAULT 'waiting_opponent';
ALTER TABLE duel_matches ADD COLUMN IF NOT EXISTS activity_player SMALLINT;
ALTER TABLE duel_matches ADD COLUMN IF NOT EXISTS activity_updated_at TIMESTAMPTZ;
ALTER TABLE duel_matches ADD COLUMN IF NOT EXISTS player_one_last_seen_at TIMESTAMPTZ;
ALTER TABLE duel_matches ADD COLUMN IF NOT EXISTS player_two_last_seen_at TIMESTAMPTZ;
ALTER TABLE duel_matches ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMPTZ;
ALTER TABLE duel_matches ADD COLUMN IF NOT EXISTS rematch_requested_by SMALLINT;
ALTER TABLE duel_rounds ADD COLUMN IF NOT EXISTS challenge_idempotency_key VARCHAR(96);
ALTER TABLE duel_rounds ADD COLUMN IF NOT EXISTS attempt_idempotency_key VARCHAR(96);
CREATE UNIQUE INDEX IF NOT EXISTS ux_duel_round_challenge_idem ON duel_rounds(match_id, challenge_idempotency_key) WHERE challenge_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_duel_round_attempt_idem ON duel_rounds(match_id, attempt_idempotency_key) WHERE attempt_idempotency_key IS NOT NULL;

UPDATE duel_matches AS matches
SET current_round = rounds.round_number,
    active_player = CASE
      WHEN rounds.status = 'awaiting_attempt' THEN rounds.responder
      ELSE rounds.challenger
    END
FROM duel_rounds AS rounds
WHERE rounds.match_id = matches.id
  AND rounds.status <> 'complete'
  AND rounds.round_number = (
    SELECT MIN(candidate.round_number)
    FROM duel_rounds AS candidate
    WHERE candidate.match_id = matches.id AND candidate.status <> 'complete'
  );

UPDATE duel_matches
SET current_round = 2
WHERE status = 'finished';
