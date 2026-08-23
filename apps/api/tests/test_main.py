import uuid

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base, get_db
from app.main import app
from app.settings import settings


client = TestClient(app)


def test_health_without_database_is_available():
    response = client.get('/health')
    assert response.status_code == 200
    assert response.json()['status'] == 'ok'


def test_create_session_without_database_still_returns_id():
    response = client.post(
        '/v1/sessions',
        json={
            'source': 'web',
            'campaign': 'reverse_game',
            'platform': 'web',
        },
    )
    assert response.status_code == 201
    session_id = response.json()['id']
    assert uuid.UUID(session_id)


def test_result_validation_rejects_out_of_range_score():
    response = client.post(
        f'/v1/sessions/{uuid.uuid4()}/result',
        json={
            'score': 101,
            'original_duration_ms': 1500,
            'attempt_duration_ms': 1500,
            'acoustic_similarity': 0.8,
            'rhythm_similarity': 0.8,
            'duration_similarity': 0.8,
        },
    )
    assert response.status_code == 422


def test_easysong_redirect_works_without_database(monkeypatch):
    destination = 'https://easysong.ru/webapp/auth?next=%2Fwebapp'
    monkeypatch.setattr(settings, 'easysong_url', destination)
    response = client.get('/go/easysong?source=web&campaign=reverse_game', follow_redirects=False)
    assert response.status_code == 302
    assert response.headers['location'] == destination


def test_telegram_auth_reports_not_configured(monkeypatch):
    monkeypatch.setattr(settings, 'telegram_bot_token', None)
    response = client.post('/v1/auth/telegram', json={'init_data': 'auth_date=1&hash=x'})
    assert response.status_code == 503


def test_match_requires_persistent_database():
    response = client.post('/v1/matches', json={'session_id': None})
    assert response.status_code == 503


def test_round_score_validation_rejects_invalid_breakdown():
    response = client.post(
        f'/v1/matches/{uuid.uuid4()}/rounds/1/score',
        headers={'X-Player-Token': 'invalid'},
        json={'score': 101, 'acoustic_similarity': 1, 'rhythm_similarity': 1, 'duration_similarity': 1},
    )
    assert response.status_code == 422


def test_waiting_match_can_be_cancelled_only_by_creator():
    test_engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    session_factory = sessionmaker(bind=test_engine)
    Base.metadata.create_all(test_engine)

    def override_database():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_database
    try:
        with TestClient(app) as database_client:
            created = database_client.post('/v1/matches', json={'session_id': None}).json()
            match_id, invite, creator_token = created['id'], created['invite_token'], created['player_token']

            denied = database_client.post(f'/v1/matches/{match_id}/cancel', headers={'X-Player-Token': 'wrong'})
            assert denied.status_code == 403

            cancelled = database_client.post(f'/v1/matches/{match_id}/cancel', headers={'X-Player-Token': creator_token})
            assert cancelled.status_code == 200
            assert cancelled.json() == {'cancelled': True}

            assert database_client.post(f'/v1/matches/join/{invite}', json={}).status_code == 410
    finally:
        app.dependency_overrides.pop(get_db, None)
        Base.metadata.drop_all(test_engine)
        test_engine.dispose()


def test_started_match_cannot_be_cancelled():
    test_engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    session_factory = sessionmaker(bind=test_engine)
    Base.metadata.create_all(test_engine)

    def override_database():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_database
    try:
        with TestClient(app) as database_client:
            created = database_client.post('/v1/matches', json={'session_id': None}).json()
            database_client.post(f"/v1/matches/join/{created['invite_token']}", json={})
            response = database_client.post(
                f"/v1/matches/{created['id']}/cancel",
                headers={'X-Player-Token': created['player_token']},
            )
            assert response.status_code == 409
    finally:
        app.dependency_overrides.pop(get_db, None)
        Base.metadata.drop_all(test_engine)
        test_engine.dispose()
