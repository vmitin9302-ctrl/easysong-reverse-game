import asyncio
from datetime import datetime, timezone

from aiogram.methods import SendMessage
from aiogram.types import Chat, Message, User
from aiogram.utils.serialization import deserialize_telegram_object_to_python

from app import start


def test_start_returns_direct_webhook_send_message() -> None:
    message = Message(
        message_id=1,
        date=datetime.now(timezone.utc),
        chat=Chat(id=123456, type='private'),
        from_user=User(id=123456, is_bot=False, first_name='Test'),
        text='/start',
    )

    result = asyncio.run(start(message))

    assert isinstance(result, SendMessage)
    payload = deserialize_telegram_object_to_python(result)
    assert payload['method'] == 'sendMessage'
    assert payload['chat_id'] == '123456'
    assert 'Сможешь говорить задом наперёд?' in payload['text']
    assert payload['reply_markup']['inline_keyboard'][0][0]['text'] == '🎮 Играть'
    assert payload['reply_markup']['inline_keyboard'][0][0]['web_app']['url']
