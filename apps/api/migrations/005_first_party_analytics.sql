ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS page VARCHAR(128);
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS section VARCHAR(96);
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS element VARCHAR(128);
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS action VARCHAR(64);
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS anonymous_id VARCHAR(64);
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS source VARCHAR(64);
CREATE INDEX IF NOT EXISTS ix_analytics_events_anonymous_id ON analytics_events(anonymous_id);
CREATE INDEX IF NOT EXISTS ix_analytics_events_created_at ON analytics_events(created_at);

-- Rollback (manual): DROP INDEX ix_analytics_events_created_at; DROP INDEX ix_analytics_events_anonymous_id;
-- ALTER TABLE analytics_events DROP COLUMN source, DROP COLUMN anonymous_id, DROP COLUMN action,
-- DROP COLUMN element, DROP COLUMN section, DROP COLUMN page;
