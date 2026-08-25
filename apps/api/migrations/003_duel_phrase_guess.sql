ALTER TABLE duel_rounds ADD COLUMN IF NOT EXISTS phrase_text VARCHAR(160);
ALTER TABLE duel_rounds ADD COLUMN IF NOT EXISTS guess_text VARCHAR(160);

UPDATE duel_rounds AS rounds
SET status = 'awaiting_phrase',
    challenge_object_key = NULL,
    attempt_object_key = NULL,
    audio_expires_at = NULL,
    challenge_idempotency_key = NULL,
    attempt_idempotency_key = NULL
FROM duel_matches AS matches
WHERE rounds.match_id = matches.id
  AND rounds.status IN ('awaiting_challenge', 'awaiting_attempt', 'awaiting_score')
  AND rounds.phrase_text IS NULL
  AND matches.status IN ('round_1', 'round_2');

UPDATE duel_matches AS matches
SET active_player = rounds.challenger,
    activity_status = 'writing_phrase',
    activity_player = rounds.challenger,
    activity_updated_at = now(),
    revision = matches.revision + 1,
    updated_at = now()
FROM duel_rounds AS rounds
WHERE rounds.match_id = matches.id
  AND rounds.round_number = matches.current_round
  AND rounds.status = 'awaiting_phrase'
  AND rounds.phrase_text IS NULL
  AND matches.status IN ('round_1', 'round_2');
