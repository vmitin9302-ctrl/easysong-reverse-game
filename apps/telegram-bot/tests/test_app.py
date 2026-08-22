from app import build_start_response


def test_start_returns_direct_webhook_send_message() -> None:
    payload = build_start_response(123456)

    assert payload['method'] == 'sendMessage'
    assert payload['chat_id'] == 123456
    assert 'Сможешь говорить задом наперёд?' in payload['text']
    assert payload['reply_markup']['inline_keyboard'][0][0]['text'] == '🎮 Играть'
    assert payload['reply_markup']['inline_keyboard'][0][0]['web_app']['url']
