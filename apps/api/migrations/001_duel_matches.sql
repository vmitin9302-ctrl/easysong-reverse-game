CREATE TABLE IF NOT EXISTS duel_matches (
  id UUID PRIMARY KEY, session_id UUID REFERENCES game_sessions(id), invite_token VARCHAR(32) UNIQUE NOT NULL,
  player_one_secret VARCHAR(96) NOT NULL, player_two_secret VARCHAR(96), status VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_duel_matches_invite_token ON duel_matches(invite_token);
CREATE INDEX IF NOT EXISTS ix_duel_matches_status ON duel_matches(status);
CREATE TABLE IF NOT EXISTS duel_rounds (
  id UUID PRIMARY KEY, match_id UUID NOT NULL REFERENCES duel_matches(id), round_number SMALLINT NOT NULL,
  challenger SMALLINT NOT NULL, responder SMALLINT NOT NULL, status VARCHAR(32) NOT NULL,
  challenge_object_key TEXT, attempt_object_key TEXT, audio_expires_at TIMESTAMPTZ, score SMALLINT,
  score_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(match_id, round_number)
);
CREATE INDEX IF NOT EXISTS ix_duel_rounds_match_id ON duel_rounds(match_id);
