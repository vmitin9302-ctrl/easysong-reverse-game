from contextlib import asynccontextmanager
from typing import Any

from aiogram import Bot, Dispatcher
from aiogram.filters import CommandStart
from aiogram.methods import SendMessage, TelegramMethod
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, Message, Update, WebAppInfo
from aiogram.utils.serialization import deserialize_telegram_object_to_python
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
dp = Dispatcher()
bot: Bot | None = None
webhook_registered = False


@dp.message(CommandStart())
async def start(message: Message) -> SendMessage:
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
    # Returning a TelegramMethod from a webhook handler makes Telegram execute
    # sendMessage itself as the webhook response. This avoids a second outbound
    # request from Yandex Serverless Container to api.telegram.org.
    return SendMessage(
        chat_id=message.chat.id,
        text=(
            '🎙 Сможешь говорить задом наперёд?\n\n'
            'Запиши фразу, услышь её наоборот и попробуй повторить. '
            'Посмотрим, сколько процентов ты наберёшь 😈'
        ),
        reply_markup=keyboard,
    )


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
                    allowed_updates=dp.resolve_used_update_types(),
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
        'delivery_mode': 'webhook-response',
    }


@app.get('/telegram/status')
async def telegram_status() -> dict[str, Any]:
    if bot is None:
        raise HTTPException(status_code=503, detail='Telegram bot is not configured')

    # Diagnostic endpoint only. Core /start delivery does not depend on these
    # outbound Telegram API calls.
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
    if bot is None:
        raise HTTPException(status_code=503, detail='Telegram bot is not configured')

    if settings.telegram_webhook_secret:
        received = request.headers.get('X-Telegram-Bot-Api-Secret-Token')
        if received != settings.telegram_webhook_secret:
            raise HTTPException(status_code=401, detail='Invalid webhook secret')

    payload = await request.json()
    update = Update.model_validate(payload, context={'bot': bot})
    result = await dp.feed_update(bot, update)

    if isinstance(result, TelegramMethod):
        # aiogram includes the Bot API method name (e.g. "sendMessage") and
        # converts nested Telegram objects/defaults into JSON-compatible data.
        response_payload = deserialize_telegram_object_to_python(
            result,
            default=bot.default,
            include_api_method_name=True,
        )
        return JSONResponse(content=response_payload)

    return JSONResponse(content={'ok': True})
