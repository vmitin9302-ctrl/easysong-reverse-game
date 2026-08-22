import hashlib
import hmac
import json
import time
from urllib.parse import urlencode

import pytest

from app.settings import settings
from app.telegram_auth import TelegramAuthError, validate_init_data


def make_init_data(token: str, *, auth_date: int | None = None, user_id: int = 123456) -> str:
    values = {
        'auth_date': str(auth_date if auth_date is not None else int(time.time())),
        'query_id': 'AAExampleQuery',
        'user': json.dumps({'id': user_id, 'first_name': 'Test'}, separators=(',', ':')),
    }
    data_check_string = '\n'.join(f'{key}={values[key]}' for key in sorted(values))
    secret_key = hmac.new(b'WebAppData', token.encode('utf-8'), hashlib.sha256).digest()
    values['hash'] = hmac.new(
        secret_key,
        data_check_string.encode('utf-8'),
        hashlib.sha256,
    ).hexdigest()
    return urlencode(values)


def test_valid_init_data_is_accepted_and_user_is_hashed(monkeypatch):
    token = '123456:TEST_TOKEN_FOR_UNIT_TESTS'
    monkeypatch.setattr(settings, 'telegram_bot_token', token)
    monkeypatch.setattr(settings, 'session_secret', 'unit-test-session-secret')

    result = validate_init_data(make_init_data(token))

    assert result['valid'] is True
    assert result['user_hash']
    assert result['user_hash'] != '123456'
    assert len(result['user_hash']) == 32


def test_invalid_signature_is_rejected(monkeypatch):
    token = '123456:TEST_TOKEN_FOR_UNIT_TESTS'
    monkeypatch.setattr(settings, 'telegram_bot_token', token)
    init_data = make_init_data(token).replace('hash=', 'hash=deadbeef')

    with pytest.raises(TelegramAuthError, match='Invalid signature'):
        validate_init_data(init_data)


def test_expired_init_data_is_rejected(monkeypatch):
    token = '123456:TEST_TOKEN_FOR_UNIT_TESTS'
    monkeypatch.setattr(settings, 'telegram_bot_token', token)
    old = int(time.time()) - 200_000

    with pytest.raises(TelegramAuthError, match='Expired init data'):
        validate_init_data(make_init_data(token, auth_date=old), max_age_seconds=86_400)
