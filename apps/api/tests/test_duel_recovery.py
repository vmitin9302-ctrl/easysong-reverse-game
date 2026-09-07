from datetime import UTC, datetime, timedelta
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import main
from app.db import Base, get_db
from app.models import DuelRound


@pytest.fixture
def duel(monkeypatch):
    engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    def database():
        with factory() as session:
            yield session
    main.app.dependency_overrides[get_db] = database
    monkeypatch.setattr(main, 'signed_put', lambda *args: 'https://example.invalid/upload')
    monkeypatch.setattr(main, 'delete_objects', lambda keys: None)
    with TestClient(main.app) as client:
        created = client.post('/v1/matches', json={}).json()
        yield client, factory, created
    main.app.dependency_overrides.pop(get_db, None)
    engine.dispose()


def test_lost_join_response_can_be_replayed_without_losing_slot(duel):
    client, _, created = duel
    path = f"/v1/matches/join/{created['invite_token']}"
    body = {'join_request_token': 'test-' + 'a' * 40}
    first = client.post(path, json=body)
    replay = client.post(path, json=body)
    assert first.status_code == replay.status_code == 200
    assert first.json()['player_token'] == replay.json()['player_token']
    assert replay.json()['player'] == 2
    assert client.post(path, json={'join_request_token': 'test-' + 'b' * 40}).status_code == 409


def test_missing_upload_does_not_advance_turn_and_can_be_retried(duel, monkeypatch):
    client, _, created = duel
    client.post(f"/v1/matches/join/{created['invite_token']}", json={})
    prefix = f"/v1/matches/{created['id']}/rounds/1"
    headers = {'X-Player-Token': created['player_token']}
    client.post(prefix + '/phrase', headers=headers, json={'phrase': 'тест'})
    client.post(prefix + '/challenge-upload', headers=headers, json={'content_type': 'audio/wav', 'idempotency_key': 'request-key'})
    def missing(key):
        raise RuntimeError('NoSuchKey')
    monkeypatch.setattr(main, 'validate_uploaded_audio', missing)
    assert client.post(prefix + '/challenge-ready', headers=headers).status_code == 503
    assert client.get(f"/v1/matches/{created['id']}", headers=headers).json()['rounds'][0]['status'] == 'awaiting_challenge'
    monkeypatch.setattr(main, 'validate_uploaded_audio', lambda key: None)
    assert client.post(prefix + '/challenge-ready', headers=headers).status_code == 200
    assert client.post(prefix + '/challenge-ready', headers=headers).status_code == 200


def test_expired_active_audio_is_cleaned_and_match_stops(duel, monkeypatch):
    client, factory, created = duel
    client.post(f"/v1/matches/join/{created['invite_token']}", json={})
    with factory() as session:
        row = session.query(DuelRound).filter_by(match_id=uuid.UUID(created['id']), round_number=1).one()
        row.status = 'awaiting_attempt'
        row.challenge_object_key = 'matches/expired.wav'
        row.audio_expires_at = datetime.now(UTC) - timedelta(seconds=1)
        session.commit()
    removed = []
    monkeypatch.setattr(main, 'delete_objects', lambda keys: removed.extend(keys))
    headers = {'X-Player-Token': created['player_token']}
    state = client.get(f"/v1/matches/{created['id']}", headers=headers).json()
    assert state['status'] == 'cancelled'
    assert state['activity_status'] == 'temporary_audio_expired'
    assert removed == ['matches/expired.wav']
    assert client.get(f"/v1/matches/{created['id']}", headers=headers).json()['revision'] == state['revision']


def test_cancel_can_be_retried_after_lost_response(duel):
    client, _, created = duel
    path = f"/v1/matches/{created['id']}/cancel"
    headers = {'X-Player-Token': created['player_token']}
    assert client.post(path, headers=headers).json() == client.post(path, headers=headers).json() == {'cancelled': True}


def test_request_log_is_structured_and_does_not_expose_invite_or_player_token(duel, capsys):
    import json
    client, _, created = duel
    client.post(f"/v1/matches/join/{created['invite_token']}", json={})
    raw = capsys.readouterr().out
    entries = [json.loads(line) for line in raw.splitlines() if line.startswith('{')]
    assert any(entry.get('route') == '/v1/matches/join/{invite_token}' and entry['level'] == 'INFO' for entry in entries)
    assert created['invite_token'] not in raw
    assert created['player_token'] not in raw


def test_upstream_connection_closes_and_logs_use_platform_request_id(duel, capsys):
    import json
    client, _, created = duel
    request_id = str(uuid.uuid4())
    response = client.get(f"/v1/matches/{created['id']}", headers={
        'X-Player-Token': created['player_token'], 'X-Request-Id': request_id})
    assert response.status_code == 200
    assert response.headers['connection'] == 'close'
    entries = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith('{')]
    assert entries[-1]['request_id'] == request_id
