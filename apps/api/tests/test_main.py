import uuid
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import main as main_module
from app.db import Base, get_db
from app.main import app, phrase_score
from app.models import AnalyticsEvent, DuelMatch, DuelRound
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


def test_round_text_validation_and_normalized_scoring():
    too_long = client.post(
        f'/v1/matches/{uuid.uuid4()}/rounds/1/phrase',
        headers={'X-Player-Token': 'invalid'},
        json={'phrase': 'а' * 161},
    )
    empty_guess = client.post(
        f'/v1/matches/{uuid.uuid4()}/rounds/1/guess',
        headers={'X-Player-Token': 'invalid'},
        json={'guess': ''},
    )
    assert too_long.status_code == 422
    assert empty_guess.status_code == 422
    assert phrase_score('Ёжик, иди домой!', 'ежик иди домой') == 100


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
            joined = database_client.post(f"/v1/matches/join/{created['invite_token']}", json={}).json()
            response = database_client.post(
                f"/v1/matches/{created['id']}/cancel",
                headers={'X-Player-Token': created['player_token']},
            )
            assert response.status_code == 409

            forfeited = database_client.post(
                f"/v1/matches/{created['id']}/forfeit",
                headers={'X-Player-Token': joined['player_token']},
            )
            assert forfeited.status_code == 200
            assert forfeited.json()['status'] == 'forfeited_by_2'
            assert forfeited.json()['forfeited_by'] == 2

            creator_view = database_client.get(
                f"/v1/matches/{created['id']}",
                headers={'X-Player-Token': created['player_token']},
            )
            assert creator_view.json()['forfeited_by'] == 2
            assert database_client.post(
                f"/v1/matches/{created['id']}/forfeit",
                headers={'X-Player-Token': created['player_token']},
            ).status_code == 409
    finally:
        app.dependency_overrides.pop(get_db, None)
        Base.metadata.drop_all(test_engine)
        test_engine.dispose()


def test_match_resume_presence_activity_and_authoritative_turn(monkeypatch):
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
            joined = database_client.post(f"/v1/matches/join/{created['invite_token']}", json={}).json()
            assert joined['player'] == 2
            assert joined['current_round'] == 1
            assert joined['active_player'] == 1
            assert joined['rounds'][0]['status'] == 'awaiting_phrase'
            assert joined['revision'] > created['revision']

            resumed = database_client.post(
                f"/v1/matches/join/{created['invite_token']}",
                json={'participant_token': joined['player_token']},
            )
            assert resumed.status_code == 200
            assert resumed.json()['player'] == 2
            assert resumed.json()['player_token'] == joined['player_token']

            third = database_client.post(f"/v1/matches/join/{created['invite_token']}", json={})
            assert third.status_code == 409

            activity = database_client.post(
                f"/v1/matches/{created['id']}/activity",
                headers={'X-Player-Token': created['player_token']},
                json={'status': 'writing_phrase'},
            )
            assert activity.status_code == 200
            state = database_client.get(
                f"/v1/matches/{created['id']}",
                headers={'X-Player-Token': joined['player_token']},
            ).json()
            assert state['activity_status'] == 'writing_phrase'
            assert state['activity_player'] == 1
            assert state['revision'] == activity.json()['revision']
            assert state['rounds'][0]['phrase'] is None

            not_active = database_client.post(
                f"/v1/matches/{created['id']}/activity",
                headers={'X-Player-Token': joined['player_token']},
                json={'status': 'guessing_phrase'},
            )
            assert not_active.status_code == 409

            wrong_phase = database_client.post(
                f"/v1/matches/{created['id']}/activity",
                headers={'X-Player-Token': created['player_token']},
                json={'status': 'recording_challenge'},
            )
            assert wrong_phase.status_code == 409

            phrase = 'Ёжик, иди домой!'
            phrase_saved = database_client.post(
                f"/v1/matches/{created['id']}/rounds/1/phrase",
                headers={'X-Player-Token': created['player_token']},
                json={'phrase': phrase},
            )
            assert phrase_saved.status_code == 200
            assert phrase_saved.json()['rounds'][0]['phrase'] == phrase
            responder_before_guess = database_client.get(
                f"/v1/matches/{created['id']}",
                headers={'X-Player-Token': joined['player_token']},
            ).json()
            assert responder_before_guess['rounds'][0]['phrase'] is None

            heartbeat = database_client.post(
                f"/v1/matches/{created['id']}/heartbeat",
                headers={'X-Player-Token': joined['player_token']},
                json={},
            )
            assert heartbeat.status_code == 200
            refreshed = database_client.get(
                f"/v1/matches/{created['id']}",
                headers={'X-Player-Token': created['player_token']},
            ).json()
            assert refreshed['player_two_last_seen_at'] is not None

            monkeypatch.setattr(main_module, 'signed_put', lambda key, content_type: f'https://upload.invalid/{key}')
            monkeypatch.setattr(main_module, 'signed_get', lambda key: f'https://download.invalid/{key}')
            monkeypatch.setattr(main_module, 'delete_objects', lambda keys: None)
            challenge_path = f"/v1/matches/{created['id']}/rounds/1/challenge-upload"
            upload_body = {'content_type': 'audio/wav', 'idempotency_key': 'challenge-request-1'}
            first_upload = database_client.post(
                challenge_path,
                headers={'X-Player-Token': created['player_token']},
                json=upload_body,
            )
            duplicate_upload = database_client.post(
                challenge_path,
                headers={'X-Player-Token': created['player_token']},
                json={**upload_body, 'idempotency_key': 'challenge-request-2'},
            )
            assert first_upload.status_code == 200
            assert duplicate_upload.json()['upload_url'] == first_upload.json()['upload_url']

            assert database_client.post(
                f"/v1/matches/{created['id']}/rounds/1/challenge-ready",
                headers={'X-Player-Token': created['player_token']},
            ).status_code == 200
            assert database_client.post(
                challenge_path,
                headers={'X-Player-Token': created['player_token']},
                json=upload_body,
            ).status_code == 409
            assert database_client.get(
                f"/v1/matches/{created['id']}/rounds/1/challenge-audio",
                headers={'X-Player-Token': joined['player_token']},
            ).status_code == 200

            attempt_path = f"/v1/matches/{created['id']}/rounds/1/attempt-upload"
            assert database_client.post(
                attempt_path,
                headers={'X-Player-Token': joined['player_token']},
                json={'content_type': 'audio/wav', 'idempotency_key': 'attempt-request-1'},
            ).status_code == 200
            assert database_client.post(
                f"/v1/matches/{created['id']}/rounds/1/attempt-ready",
                headers={'X-Player-Token': joined['player_token']},
            ).status_code == 200
            assert database_client.post(
                attempt_path,
                headers={'X-Player-Token': joined['player_token']},
                json={'content_type': 'audio/wav', 'idempotency_key': 'attempt-request-2'},
            ).status_code == 409
            assert database_client.get(
                f"/v1/matches/{created['id']}/rounds/1/attempt-audio",
                headers={'X-Player-Token': joined['player_token']},
            ).status_code == 200
            assert database_client.get(
                f"/v1/matches/{created['id']}/rounds/1/attempt-audio",
                headers={'X-Player-Token': created['player_token']},
            ).status_code == 200
            assert database_client.post(
                f"/v1/matches/{created['id']}/rounds/1/result-seen",
                headers={'X-Player-Token': created['player_token']},
                json={},
            ).status_code == 409

            denied_guess = database_client.post(
                f"/v1/matches/{created['id']}/rounds/1/guess",
                headers={'X-Player-Token': created['player_token']},
                json={'guess': phrase},
            )
            assert denied_guess.status_code == 409

            guessed = database_client.post(
                f"/v1/matches/{created['id']}/rounds/1/guess",
                headers={'X-Player-Token': joined['player_token']},
                json={'guess': 'ежик иди домой'},
            )
            assert guessed.status_code == 200
            assert guessed.json()['status'] == 'round_2'
            assert guessed.json()['scores'] == [None, 100]
            assert guessed.json()['rounds'][0]['phrase'] == phrase
            assert guessed.json()['rounds'][0]['guess'] == 'ежик иди домой'

            creator_result = database_client.get(
                f"/v1/matches/{created['id']}",
                headers={'X-Player-Token': created['player_token']},
            ).json()
            assert creator_result['rounds'][0]['guess'] == 'ежик иди домой'
            assert creator_result['rounds'][0]['attempt_available'] is True
            assert creator_result['rounds'][0]['result_seen'] is False

            creator_seen = database_client.post(
                f"/v1/matches/{created['id']}/rounds/1/result-seen",
                headers={'X-Player-Token': created['player_token']},
                json={},
            ).json()
            assert creator_seen['rounds'][0]['result_seen'] is True
            assert creator_seen['rounds'][0]['attempt_available'] is True
            creator_seen_again = database_client.post(
                f"/v1/matches/{created['id']}/rounds/1/result-seen",
                headers={'X-Player-Token': created['player_token']},
                json={},
            ).json()
            assert creator_seen_again['revision'] == creator_seen['revision']
            responder_seen = database_client.post(
                f"/v1/matches/{created['id']}/rounds/1/result-seen",
                headers={'X-Player-Token': joined['player_token']},
                json={},
            ).json()
            assert responder_seen['rounds'][0]['result_seen'] is True
            assert responder_seen['rounds'][0]['attempt_available'] is False
            assert database_client.get(
                f"/v1/matches/{created['id']}/rounds/1/attempt-audio",
                headers={'X-Player-Token': created['player_token']},
            ).status_code == 409

            assert database_client.post(
                f"/v1/matches/{created['id']}/forfeit",
                headers={'X-Player-Token': joined['player_token']},
            ).status_code == 200
            assert database_client.get(
                f"/v1/matches/{created['id']}/rounds/1/attempt-audio",
                headers={'X-Player-Token': joined['player_token']},
            ).status_code == 409
    finally:
        app.dependency_overrides.pop(get_db, None)
        Base.metadata.drop_all(test_engine)
        test_engine.dispose()


def test_text_scores_winner_and_legacy_rematch_reset_are_synchronized_by_player():
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
            joined = database_client.post(f"/v1/matches/join/{created['invite_token']}", json={}).json()
            with session_factory() as db:
                match = db.get(DuelMatch, uuid.UUID(created['id']))
                rounds = db.query(DuelRound).filter(DuelRound.match_id == match.id).order_by(DuelRound.round_number).all()
                rounds[0].status = 'complete'; rounds[0].phrase_text = 'первая фраза'; rounds[0].guess_text = 'первая фраза'; rounds[0].score = 81
                rounds[1].status = 'complete'; rounds[1].phrase_text = 'вторая фраза'; rounds[1].guess_text = 'вторая фраза'; rounds[1].score = 85
                match.status = 'finished'; match.current_round = 2; match.active_player = 2
                match.finished_at = datetime.now(UTC); match.revision += 1
                db.commit()

            final = database_client.get(
                f"/v1/matches/{created['id']}",
                headers={'X-Player-Token': created['player_token']},
            ).json()
            assert final['scores'] == [85, 81]
            assert final['winner'] == 1

            proposed = database_client.post(
                f"/v1/matches/{created['id']}/rematch",
                headers={'X-Player-Token': created['player_token']},
                json={},
            ).json()
            assert proposed['status'] == 'finished'
            assert proposed['rematch_requested_by'] == 1

            repeated = database_client.post(
                f"/v1/matches/{created['id']}/rematch",
                headers={'X-Player-Token': created['player_token']},
                json={},
            ).json()
            assert repeated['revision'] == proposed['revision']

            accepted = database_client.post(
                f"/v1/matches/{created['id']}/rematch",
                headers={'X-Player-Token': joined['player_token']},
                json={},
            ).json()
            assert accepted['status'] == 'round_1'
            assert accepted['current_round'] == 1
            assert accepted['active_player'] == 1
            assert accepted['scores'] == [None, None]
            assert accepted['winner'] is None
            assert accepted['activity_status'] == 'rematch_started'
            assert all(row['status'] == 'awaiting_phrase' for row in accepted['rounds'])
            assert all(row['phrase'] is None and row['guess'] is None for row in accepted['rounds'])
            assert all(row['result_seen'] is False for row in accepted['rounds'])
    finally:
        app.dependency_overrides.pop(get_db, None)
        Base.metadata.drop_all(test_engine)
        test_engine.dispose()


def test_expired_invite_rejects_new_player_but_allows_creator_resume():
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
            with session_factory() as db:
                match = db.get(DuelMatch, uuid.UUID(created['id']))
                match.invite_expires_at = datetime.now(UTC) - timedelta(seconds=1)
                db.commit()

            expired = database_client.post(f"/v1/matches/join/{created['invite_token']}", json={})
            assert expired.status_code == 410

            resumed = database_client.post(
                f"/v1/matches/join/{created['invite_token']}",
                json={'participant_token': created['player_token']},
            )
            assert resumed.status_code == 200
            assert resumed.json()['player'] == 1
    finally:
        app.dependency_overrides.pop(get_db, None)
        Base.metadata.drop_all(test_engine)
        test_engine.dispose()


def test_analytics_ingest_and_admin_summary_are_protected(monkeypatch):
    test_engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    session_factory = sessionmaker(bind=test_engine)
    Base.metadata.create_all(test_engine)

    def override_database():
        with session_factory() as db:
            yield db

    app.dependency_overrides[get_db] = override_database
    monkeypatch.setattr(settings, 'analytics_ingest_token', 'ingest-test-token')
    monkeypatch.setattr(settings, 'analytics_admin_token', 'admin-test-token')
    try:
        with TestClient(app) as database_client:
            assert database_client.post('/v1/bot/events', json={'event_name': 'bot_started'}).status_code == 401
            accepted = database_client.post(
                '/v1/bot/events',
                headers={'X-Analytics-Token': 'ingest-test-token'},
                json={'event_name': 'bot_started', 'anonymous_id': 'anonymous-test-id'},
            )
            assert accepted.status_code == 202
            assert database_client.get('/v1/admin/analytics').status_code == 401
            report = database_client.get(
                '/v1/admin/analytics?days=30', headers={'Authorization': 'Bearer admin-test-token'}
            )
            assert report.status_code == 200
            assert report.json()['totals']['bot_starts'] == 1
            with session_factory() as db:
                event = db.query(AnalyticsEvent).one()
                assert event.source == 'telegram_bot'
                assert event.anonymous_id == 'anonymous-test-id'
    finally:
        app.dependency_overrides.pop(get_db, None)
        Base.metadata.drop_all(test_engine)
        test_engine.dispose()
