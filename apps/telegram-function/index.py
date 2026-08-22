import base64
import json
import os
from typing import Any

WEBAPP_URL = os.getenv(
    'TELEGRAM_WEBAPP_URL',
    'https://easygame7-d81bb227-42b6a9.website.yandexcloud.net',
)
WEBHOOK_SECRET = os.getenv('TELEGRAM_WEBHOOK_SECRET', '')


def _headers(event: dict[str, Any]) -> dict[str, str]:
    raw = event.get('headers') or {}
    return {str(k).lower(): str(v) for k, v in raw.items()}


def _payload(event: dict[str, Any]) -> dict[str, Any]:
    body = event.get('body')
    if event.get('isBase64Encoded') and isinstance(body, str):
        body = base64.b64decode(body).decode('utf-8')
    if isinstance(body, str):
        return json.loads(body or '{}')
    if isinstance(body, dict):
        return body
    # Direct function invocation in tests can pass the Telegram update itself.
    if 'update_id' in event:
        return event
    return {}


def build_start_response(chat_id: int) -> dict[str, Any]:
    return {
        'method': 'sendMessage',
        'chat_id': chat_id,
        'text': (
            '🎙 Сможешь говорить задом наперёд?\n\n'
            'Запиши фразу, услышь её наоборот и попробуй повторить. '
            'Посмотрим, сколько процентов ты наберёшь 😈'
        ),
        'reply_markup': {
            'inline_keyboard': [[{
                'text': '🎮 Играть',
                'web_app': {'url': WEBAPP_URL},
            }]],
        },
    }


def _response(status: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        'statusCode': status,
        'headers': {'Content-Type': 'application/json'},
        'isBase64Encoded': False,
        'body': json.dumps(body, ensure_ascii=False, separators=(',', ':')),
    }


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    headers = _headers(event)
    if WEBHOOK_SECRET:
        received = headers.get('x-telegram-bot-api-secret-token', '')
        if received != WEBHOOK_SECRET:
            return _response(401, {'ok': False, 'error': 'invalid webhook secret'})

    try:
        update = _payload(event)
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return _response(400, {'ok': False, 'error': 'invalid json'})

    message = update.get('message') or {}
    text = message.get('text')
    chat_id = (message.get('chat') or {}).get('id')

    if isinstance(text, str) and text.split(maxsplit=1)[0].split('@', 1)[0] == '/start' and isinstance(chat_id, int):
        return _response(200, build_start_response(chat_id))

    return _response(200, {'ok': True})
