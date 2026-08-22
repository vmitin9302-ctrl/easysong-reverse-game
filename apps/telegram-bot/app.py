from contextlib import asynccontextmanager

from aiogram import Bot, Dispatcher
from aiogram.filters import CommandStart
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, Message, Update, WebAppInfo
from fastapi import FastAPI, HTTPException, Request
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')

    telegram_bot_token: str | None = None
    telegram_webapp_url: str = 'http://localhost:5173'
    telegram_webhook_url: str | None = None
    telegram_webhook_secret: str | None = None


settings = Settings()
dp = Dispatcher()
bot: Bot | None = None


@dp.message(CommandStart())
async def start(message: Message) -> None:
    keyboard = InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text='🎮 Играть',
                    web_app=WebAppInfo(url=settings.telegram_webapp_url),
                )
            ]
        ]
    )
    await message.answer(
        '🎙 Сможешь говорить задом наперёд?\n\n'
        'Запиши фразу, услышь её наоборот и попробуй повторить. '
        'Посмотрим, сколько процентов ты наберёшь 😈',
        reply_markup=keyboard,
    )


@asynccontextmanager
async def lifespan(_: FastAPI):
    global bot
    if settings.telegram_bot_token:
        bot = Bot(settings.telegram_bot_token)
        if settings.telegram_webhook_url:
            await bot.set_webhook(
                url=settings.telegram_webhook_url,
                secret_token=settings.telegram_webhook_secret or None,
                allowed_updates=dp.resolve_used_update_types(),
                drop_pending_updates=False,
            )
    yield
    if bot is not None:
        await bot.session.close()
        bot = None


app = FastAPI(title='EasySong Reverse Game Telegram Bot', lifespan=lifespan)


@app.get('/health')
async def health() -> dict:
    return {
        'status': 'ok',
        'configured': bool(settings.telegram_bot_token),
        'webhook_url': settings.telegram_webhook_url,
    }


@app.get('/telegram/status')
async def telegram_status() -> dict:
    if bot is None:
        raise HTTPException(status_code=503, detail='Telegram bot is not configured')

    identity = await bot.get_me()
    webhook = await bot.get_webhook_info()
    return {
        'bot_username': identity.username,
        'url': webhook.url,
        'pending_updates': webhook.pending_update_count,
        'last_error': webhook.last_error_message,
    }


@app.post('/telegram/webhook')
async def telegram_webhook(request: Request) -> dict:
    if bot is None:
        raise HTTPException(status_code=503, detail='Telegram bot is not configured')

    if settings.telegram_webhook_secret:
        received = request.headers.get('X-Telegram-Bot-Api-Secret-Token')
        if received != settings.telegram_webhook_secret:
            raise HTTPException(status_code=401, detail='Invalid webhook secret')

    payload = await request.json()
    update = Update.model_validate(payload, context={'bot': bot})
    await dp.feed_update(bot, update)
    return {'ok': True}
