import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

BOT_TOKEN = os.getenv('TELEGRAM_BOT_TOKEN', '')
WEBAPP_URL = os.getenv(
    'TELEGRAM_WEBAPP_URL',
    'https://easygame7-d81bb227-42b6a9.website.yandexcloud.net',
)
API_BASE = f'https://api.telegram.org/bot{BOT_TOKEN}'


def _api(method: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    if not BOT_TOKEN:
        raise RuntimeError('TELEGRAM_BOT_TOKEN is not configured')

    encoded = None
    headers: dict[str, str] = {}
    if data is not None:
        encoded = json.dumps(data, ensure_ascii=False).encode('utf-8')
        headers['Content-Type'] = 'application/json'

    request = urllib.request.Request(
        f'{API_BASE}/{method}',
        data=encoded,
        headers=headers,
        method='POST' if data is not None else 'GET',
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode('utf-8', errors='replace')
        raise RuntimeError(f'Telegram HTTP {exc.code}: {body[:500]}') from exc

    if not payload.get('ok'):
        raise RuntimeError(f'Telegram API error: {payload}')
    return payload


def _start_message(chat_id: int) -> dict[str, Any]:
    return {
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


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    # Negative offset asks Telegram for the tail of the pending queue, so this
    # worker does not need a separate persistent offset store. The final
    # max_update_id + 1 request confirms everything processed in this batch.
    query = urllib.parse.urlencode({
        'offset': -100,
        'limit': 100,
        'timeout': 0,
        'allowed_updates': json.dumps(['message']),
    })
    updates = _api(f'getUpdates?{query}').get('result', [])

    if not updates:
        return {'ok': True, 'updates': 0, 'start_chats': 0}

    unique_start_chats: set[int] = set()
    max_update_id: int | None = None

    for update in updates:
        update_id = update.get('update_id')
        if isinstance(update_id, int):
            max_update_id = update_id if max_update_id is None else max(max_update_id, update_id)

        message = update.get('message') or {}
        text = message.get('text')
        chat_id = (message.get('chat') or {}).get('id')
        if (
            isinstance(text, str)
            and text.split(maxsplit=1)[0].split('@', 1)[0] == '/start'
            and isinstance(chat_id, int)
        ):
            unique_start_chats.add(chat_id)

    sent = 0
    for chat_id in unique_start_chats:
        _api('sendMessage', _start_message(chat_id))
        sent += 1

    if max_update_id is not None:
        confirm = urllib.parse.urlencode({
            'offset': max_update_id + 1,
            'limit': 1,
            'timeout': 0,
            'allowed_updates': json.dumps(['message']),
        })
        _api(f'getUpdates?{confirm}')

    return {
        'ok': True,
        'updates': len(updates),
        'start_chats': len(unique_start_chats),
        'messages_sent': sent,
        'max_update_id': max_update_id,
    }
