import hashlib
import hmac
import json
import time
from urllib.parse import parse_qsl

from .settings import settings


class TelegramAuthError(ValueError):
    pass


def validate_init_data(init_data: str, max_age_seconds: int = 86_400) -> dict:
    if not settings.telegram_bot_token:
        raise TelegramAuthError('Telegram bot token is not configured')

    values = dict(parse_qsl(init_data, keep_blank_values=True))
    received_hash = values.pop('hash', None)
    if not received_hash:
        raise TelegramAuthError('Missing hash')

    data_check_string = '\n'.join(f'{key}={values[key]}' for key in sorted(values))
    secret_key = hmac.new(
        b'WebAppData',
        settings.telegram_bot_token.encode('utf-8'),
        hashlib.sha256,
    ).digest()
    calculated_hash = hmac.new(
        secret_key,
        data_check_string.encode('utf-8'),
        hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(calculated_hash, received_hash):
        raise TelegramAuthError('Invalid signature')

    auth_date_raw = values.get('auth_date')
    if not auth_date_raw:
        raise TelegramAuthError('Missing auth_date')
    try:
        auth_date = int(auth_date_raw)
    except ValueError as exc:
        raise TelegramAuthError('Invalid auth_date') from exc

    if abs(int(time.time()) - auth_date) > max_age_seconds:
        raise TelegramAuthError('Expired init data')

    user = {}
    if values.get('user'):
        try:
            user = json.loads(values['user'])
        except json.JSONDecodeError as exc:
            raise TelegramAuthError('Invalid user payload') from exc

    user_id = str(user.get('id', ''))
    user_hash = None
    if user_id:
        user_hash = hmac.new(
            settings.session_secret.encode('utf-8'),
            user_id.encode('utf-8'),
            hashlib.sha256,
        ).hexdigest()[:32]

    return {
        'valid': True,
        'user_hash': user_hash,
        'start_param': values.get('start_param'),
        'query_id': values.get('query_id'),
    }
