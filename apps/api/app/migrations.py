from pathlib import Path

from sqlalchemy import MetaData, text
from sqlalchemy.engine import Engine


MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / 'migrations'
MIGRATION_LOCK_ID = 712_940_221


def apply_runtime_migrations(engine: Engine, metadata: MetaData) -> None:
    if engine.dialect.name != 'postgresql':
        metadata.create_all(bind=engine)
        return
    with engine.begin() as connection:
        connection.execute(text('SELECT pg_advisory_xact_lock(:lock_id)'), {'lock_id': MIGRATION_LOCK_ID})
        metadata.create_all(bind=connection)
        connection.exec_driver_sql(
            'CREATE TABLE IF NOT EXISTS schema_migrations ('
            'version VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
        )
        applied = {
            row[0]
            for row in connection.exec_driver_sql('SELECT version FROM schema_migrations').fetchall()
        }
        for migration in sorted(MIGRATIONS_DIR.glob('*.sql')):
            if migration.name in applied:
                continue
            statements = [statement.strip() for statement in migration.read_text(encoding='utf-8').split(';') if statement.strip()]
            for statement in statements:
                connection.exec_driver_sql(statement)
            connection.execute(text('INSERT INTO schema_migrations(version) VALUES (:version)'), {'version': migration.name})
