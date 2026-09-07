import os
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import create_engine, text

from app.db import Base
from app import models  # noqa: F401
from app.migrations import apply_runtime_migrations


@pytest.mark.skipif(not os.getenv('TEST_POSTGRES_URL'), reason='Requires isolated PostgreSQL test service')
def test_postgres_upgrade_and_concurrent_migration_startup():
    engine = create_engine(os.environ['TEST_POSTGRES_URL'])
    # The CI database is dedicated to this test. No production connection is used.
    with engine.begin() as connection:
        connection.exec_driver_sql('CREATE TABLE game_sessions (id UUID PRIMARY KEY)')
        source = Path(__file__).resolve().parents[1] / 'migrations' / '001_duel_matches.sql'
        for statement in source.read_text().split(';'):
            if statement.strip():
                connection.exec_driver_sql(statement)
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: apply_runtime_migrations(engine, Base.metadata), range(2)))
    with engine.connect() as connection:
        assert connection.execute(text('SELECT count(*) FROM schema_migrations')).scalar() == 6
        assert connection.execute(text("SELECT count(*) FROM pg_indexes WHERE indexname='ix_analytics_events_anonymous_id'")).scalar() == 1
        for column in ('revision', 'current_round', 'active_player', 'invite_expires_at'):
            assert connection.execute(text("SELECT 1 FROM information_schema.columns WHERE table_name='duel_matches' AND column_name=:column"), {'column': column}).scalar() == 1
    engine.dispose()
