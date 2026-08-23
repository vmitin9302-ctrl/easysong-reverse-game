import asyncio
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from typing import Any

from aiogram import Bot, Dispatcher
from aiogram.filters import CommandStart
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, Message, WebAppInfo
from fastapi import FastAPI
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')

    telegram_bot_token: str | None = None
    telegram_webapp_url: str = 'http://localhost:5173'


settings = Settings()
dp = Dispatcher()
bot: Bot | None = None
polling_task: asyncio.Task[Any] | None = None
polling_started_at: str | None = None
start_requests = 0
last_start_at: str | None = None


START_TEXT = (
    '😈 Думаешь, тебя легко запутать?\n\n'
    'Проверь себя в челлендже «Наоборот».\n\n'
    'Скажи обычную фразу → услышь её задом наперёд → '
    'попробуй повторить этот звук. А потом посмотрим, насколько близко ты попал 👀\n\n'
    'Спойлер: с первого раза получается далеко не у всех 😏\n\n'
    '🎁 А когда закончишь, я покажу тебе сервис, где можно создавать '
    'песни, картинки, открытки и не только.\n\n'
    'Ну что, проверим тебя? 👇'
)


def build_start_response(chat_id: int) -> dict[str, Any]:
    return {
        'method': 'sendMessage',
        'chat_id': chat_id,
        'text': START_TEXT,
        'reply_markup': {
            'inline_keyboard': [[{
                'text': '🎮 Проверить себя',
                'web_app': {'url': settings.telegram_webapp_url},
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
                web_app=WebAppInfo(url=settings.telegram_webapp_url),
            )
        ]]
    )
    await message.answer(START_TEXT, reply_markup=keyboard)
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
