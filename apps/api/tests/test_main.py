import uuid

from fastapi.testclient import TestClient

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
