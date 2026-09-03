from app import build_start_response


def test_start_button_opens_the_configured_cross_platform_web_app() -> None:
    payload = build_start_response(123456)

    assert payload['method'] == 'sendMessage'
    assert payload['chat_id'] == 123456
    assert 'кто из вас лучше умеет говорить' in payload['text']
    assert 'первый говорит обычную фразу' in payload['text'].lower()
    assert 'в конце вас ждёт небольшой сюрприз' in payload['text']
    assert payload['reply_markup']['inline_keyboard'][0][0]['text'] == '🎮 Проверить себя'
    assert payload['reply_markup']['inline_keyboard'][0][0]['web_app']['url']
