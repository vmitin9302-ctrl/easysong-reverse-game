from datetime import datetime, timezone
from time import monotonic
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')

    telegram_bot_token: str | None = None
    telegram_webapp_url: str = 'http://localhost:5173'
    telegram_webhook_url: str | None = None
    telegram_webhook_secret: str | None = None


settings = Settings()
webhook_requests = 0
invalid_secret_requests = 0
start_requests = 0
duplicate_start_requests = 0
last_update_id: int | None = None
last_start_at: str | None = None
recent_start_chats: dict[int, float] = {}


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
            'inline_keyboard': [
                [
                    {
                        'text': '🎮 Играть',
                        'web_app': {'url': settings.telegram_webapp_url},
                    }
                ]
            ]
        },
    }


app = FastAPI(title='EasySong Reverse Game Telegram Bot')


@app.get('/health')
async def health() -> dict[str, Any]:
    return {
        'status': 'ok',
        'configured': bool(settings.telegram_bot_token),
        'webhook_url': settings.telegram_webhook_url,
        'registration_mode': 'external-github',
        'delivery_mode': 'direct-json-webhook-response',
        'webhook_requests': webhook_requests,
        'invalid_secret_requests': invalid_secret_requests,
        'start_requests': start_requests,
        'duplicate_start_requests': duplicate_start_requests,
        'last_update_id': last_update_id,
        'last_start_at': last_start_at,
    }


@app.get('/telegram/status')
async def telegram_status() -> dict[str, Any]:
    # No outbound Telegram API calls are made from the Serverless Container.
    # Direct Bot API diagnostics are performed from GitHub Actions instead.
    return {
        'configured_webhook_url': settings.telegram_webhook_url,
        'registration_mode': 'external-github',
        'delivery_mode': 'direct-json-webhook-response',
        'webhook_requests': webhook_requests,
        'start_requests': start_requests,
        'last_update_id': last_update_id,
        'last_start_at': last_start_at,
    }


@app.post('/telegram/webhook')
async def telegram_webhook(request: Request) -> JSONResponse:
    global webhook_requests, invalid_secret_requests, start_requests
    global duplicate_start_requests, last_update_id, last_start_at

    webhook_requests += 1

    if not settings.telegram_bot_token:
        raise HTTPException(status_code=503, detail='Telegram bot is not configured')

    if settings.telegram_webhook_secret:
        received = request.headers.get('X-Telegram-Bot-Api-Secret-Token')
        if received != settings.telegram_webhook_secret:
            invalid_secret_requests += 1
            print('telegram_webhook invalid_secret', flush=True)
            raise HTTPException(status_code=401, detail='Invalid webhook secret')

    payload = await request.json()
    update_id = payload.get('update_id')
    if isinstance(update_id, int):
        last_update_id = update_id

    message = payload.get('message') or {}
    text = message.get('text')
    chat = message.get('chat') or {}
    chat_id = chat.get('id')

    print(
        f'telegram_webhook update_id={update_id!r} text={text!r} chat_present={chat_id is not None}',
        flush=True,
    )

    if isinstance(text, str) and text.split(maxsplit=1)[0].split('@', 1)[0] == '/start' and isinstance(chat_id, int):
        now = monotonic()
        previous = recent_start_chats.get(chat_id)
        recent_start_chats[chat_id] = now

        if previous is not None and now - previous < 30:
            duplicate_start_requests += 1
            print(f'telegram_webhook duplicate_start update_id={update_id!r}', flush=True)
            return JSONResponse(content={'ok': True})

        start_requests += 1
        last_start_at = datetime.now(timezone.utc).isoformat()
        print(f'telegram_webhook start_response update_id={update_id!r}', flush=True)
        return JSONResponse(content=build_start_response(chat_id))

    return JSONResponse(content={'ok': True})
