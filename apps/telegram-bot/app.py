import asyncio
import hashlib
import hmac
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from typing import Any

from aiogram import Bot, Dispatcher
from aiogram.filters import CommandStart
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, Message, WebAppInfo
from fastapi import FastAPI
import httpx
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')

    telegram_bot_token: str | None = None
    telegram_webapp_url: str = 'http://localhost:5173'
    analytics_api_url: str | None = None
    analytics_ingest_token: str | None = None


settings = Settings()
dp = Dispatcher()
bot: Bot | None = None
polling_task: asyncio.Task[Any] | None = None
polling_started_at: str | None = None
start_requests = 0
last_start_at: str | None = None
seen_starters: set[str] = set()


START_TEXT = (
    '🎙 Сейчас выясним, кто из вас лучше умеет говорить на языке, '
    'которого не существует.\n\n'
    'Первый говорит обычную фразу.\n'
    'Мы превращаем её в аудио наоборот.\n'
    'Второй пытается повторить то, что услышал.\n\n'
    'Потом переворачиваем запись обратно и слушаем результат.\n\n'
    'Иногда получается почти идеально.\n'
    'Иногда — новый диалект человечества 😂\n\n'
    'Ну что, проверим вашу дуэль?\n\n'
    '🎁 И не спешите уходить после игры — в конце вас ждёт небольшой сюрприз '
    'и идея, как можно необычно порадовать своих родных и близких.'
)


def tracked_webapp_url() -> str:
    separator = '&' if '?' in settings.telegram_webapp_url else '?'
    return f'{settings.telegram_webapp_url}{separator}utm_source=telegram_bot&utm_medium=bot&utm_campaign=reverse_game&utm_content=check_yourself'


def anonymous_chat_id(chat_id: int) -> str | None:
    if not settings.analytics_ingest_token:
        return None
    return hmac.new(settings.analytics_ingest_token.encode(), str(chat_id).encode(), hashlib.sha256).hexdigest()[:32]


async def send_analytics(event_name: str, *, chat_id: int, source: str | None = None) -> None:
    if not settings.analytics_api_url or not settings.analytics_ingest_token:
        return
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            await client.post(
                f'{settings.analytics_api_url.rstrip("/")}/v1/bot/events',
                headers={'X-Analytics-Token': settings.analytics_ingest_token},
                json={'event_name': event_name, 'page': 'telegram_bot', 'section': 'start', 'action': 'command',
                      'anonymous_id': anonymous_chat_id(chat_id), 'source': source or 'telegram_bot'},
            )
    except httpx.HTTPError:
        # Analytics must never interrupt bot replies or long polling.
        pass


def build_start_response(chat_id: int) -> dict[str, Any]:
    return {
        'method': 'sendMessage',
        'chat_id': chat_id,
        'text': START_TEXT,
        'reply_markup': {
            'inline_keyboard': [[{
                'text': '🎮 Проверить себя',
                'web_app': {'url': tracked_webapp_url()},
            }]],
        },
    }


@dp.message(CommandStart())
async def start(message: Message) -> None:
    global start_requests, last_start_at

    keyboard = InlineKeyboardMarkup(
        inline_keyboard=[[
            InlineKeyboardButton(
                text='🎮 Проверить себя',
                web_app=WebAppInfo(url=tracked_webapp_url()),
            )
        ]]
    )
    await message.answer(START_TEXT, reply_markup=keyboard)
    starter_id = anonymous_chat_id(message.chat.id)
    parts = message.text.split(maxsplit=1) if message.text else []
    start_source = parts[1][:64] if len(parts) > 1 else 'direct'
    await send_analytics('bot_started', chat_id=message.chat.id, source=start_source)
    if starter_id and starter_id in seen_starters:
        await send_analytics('bot_restarted', chat_id=message.chat.id, source=start_source)
    if starter_id:
        seen_starters.add(starter_id)
    start_requests += 1
    last_start_at = datetime.now(timezone.utc).isoformat()


@asynccontextmanager
async def lifespan(_: FastAPI):
    global bot, polling_task, polling_started_at

    if settings.telegram_bot_token:
        bot = Bot(settings.telegram_bot_token)

        # Railway keeps the service alive, so long polling is both faster and
        # simpler than relying on an inbound webhook. Remove any old Yandex
        # webhook while preserving queued Telegram updates.
        await bot.delete_webhook(drop_pending_updates=False)

        polling_started_at = datetime.now(timezone.utc).isoformat()
        polling_task = asyncio.create_task(
            dp.start_polling(
                bot,
                allowed_updates=dp.resolve_used_update_types(),
                handle_signals=False,
                close_bot_session=False,
            )
        )

    yield

    if polling_task is not None:
        polling_task.cancel()
        with suppress(asyncio.CancelledError):
            await polling_task
        polling_task = None

    if bot is not None:
        await bot.session.close()
        bot = None


app = FastAPI(title='EasySong Reverse Game Telegram Bot', lifespan=lifespan)


@app.get('/health')
async def health() -> dict[str, Any]:
    task_running = polling_task is not None and not polling_task.done()
    return {
        'status': 'ok' if settings.telegram_bot_token and task_running else 'degraded',
        'configured': bool(settings.telegram_bot_token),
        'delivery_mode': 'railway-long-polling',
        'polling': task_running,
        'polling_started_at': polling_started_at,
        'start_requests': start_requests,
        'last_start_at': last_start_at,
        'webapp_url': settings.telegram_webapp_url,
    }


@app.get('/telegram/status')
async def telegram_status() -> dict[str, Any]:
    task_running = polling_task is not None and not polling_task.done()
    return {
        'mode': 'railway-long-polling',
        'configured': bool(settings.telegram_bot_token),
        'polling': task_running,
        'polling_started_at': polling_started_at,
        'start_requests': start_requests,
        'last_start_at': last_start_at,
    }
