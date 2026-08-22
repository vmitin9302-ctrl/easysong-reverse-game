from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

from aiogram import Bot
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
bot: Bot | None = None
webhook_registered = False
webhook_requests = 0
invalid_secret_requests = 0
start_requests = 0
last_update_id: int | None = None
last_start_at: str | None = None


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


@asynccontextmanager
async def lifespan(_: FastAPI):
    global bot, webhook_registered
    webhook_registered = False
    if settings.telegram_bot_token:
        bot = Bot(settings.telegram_bot_token)
        if settings.telegram_webhook_url:
            webhook_registered = bool(
                await bot.set_webhook(
                    url=settings.telegram_webhook_url,
                    secret_token=settings.telegram_webhook_secret or None,
                    allowed_updates=['message'],
                    drop_pending_updates=False,
                )
            )
    yield
    if bot is not None:
        await bot.session.close()
        bot = None
    webhook_registered = False


app = FastAPI(title='EasySong Reverse Game Telegram Bot', lifespan=lifespan)


@app.get('/health')
async def health() -> dict[str, Any]:
    return {
        'status': 'ok',
        'configured': bool(settings.telegram_bot_token),
        'webhook_url': settings.telegram_webhook_url,
        'webhook_registered': webhook_registered,
        'delivery_mode': 'direct-json-webhook-response',
        'webhook_requests': webhook_requests,
        'invalid_secret_requests': invalid_secret_requests,
        'start_requests': start_requests,
        'last_update_id': last_update_id,
        'last_start_at': last_start_at,
    }


@app.get('/telegram/status')
async def telegram_status() -> dict[str, Any]:
    if bot is None:
        raise HTTPException(status_code=503, detail='Telegram bot is not configured')

    webhook = await bot.get_webhook_info()
    return {
        'url': webhook.url,
        'pending_updates': webhook.pending_update_count,
        'last_error': webhook.last_error_message,
        'configured_webhook_url': settings.telegram_webhook_url,
        'webhook_registered_on_startup': webhook_registered,
    }


@app.post('/telegram/webhook')
async def telegram_webhook(request: Request) -> JSONResponse:
    global webhook_requests, invalid_secret_requests, start_requests, last_update_id, last_start_at

    webhook_requests += 1

    if bot is None:
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
        start_requests += 1
        last_start_at = datetime.now(timezone.utc).isoformat()
        response = build_start_response(chat_id)
        print(f'telegram_webhook start_response update_id={update_id!r}', flush=True)
        return JSONResponse(content=response)

    return JSONResponse(content={'ok': True})
