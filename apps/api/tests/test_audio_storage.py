import io
import wave
from unittest.mock import Mock

import pytest

from app import storage


def wav():
    data = io.BytesIO()
    with wave.open(data, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b'\x01\x00' * 16000)
    return data.getvalue()


@pytest.mark.parametrize('data,valid', [(wav(), True), (b'not audio' * 100, False), (wav()[:100], False), (b'', False)], ids=['valid', 'invalid', 'truncated', 'empty'])
def test_uploaded_audio_is_validated_before_ready(monkeypatch, data, valid):
    client = Mock()
    client.head_object.return_value = {'ContentLength': len(data)}
    client.get_object.return_value = {'Body': io.BytesIO(data)}
    monkeypatch.setattr(storage, 'storage_client', lambda: client)
    if valid:
        storage.validate_uploaded_audio('matches/test.wav')
    else:
        with pytest.raises(ValueError):
            storage.validate_uploaded_audio('matches/test.wav')


def test_unavailable_storage_does_not_confirm_upload(monkeypatch):
    monkeypatch.setattr(storage, 'storage_client', lambda: None)
    with pytest.raises(RuntimeError):
        storage.validate_uploaded_audio('matches/test.wav')
