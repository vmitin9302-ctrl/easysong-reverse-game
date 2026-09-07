from functools import lru_cache

import boto3
from botocore.config import Config

from .settings import settings


@lru_cache
def storage_client():
    if not all((settings.s3_bucket, settings.s3_access_key_id, settings.s3_secret_access_key)):
        return None
    return boto3.client(
        's3', endpoint_url=settings.s3_endpoint_url, region_name=settings.s3_region,
        aws_access_key_id=settings.s3_access_key_id,
        aws_secret_access_key=settings.s3_secret_access_key,
        config=Config(signature_version='s3v4', connect_timeout=3, read_timeout=5, retries={'max_attempts': 1}),
    )


def signed_put(key: str, content_type: str) -> str:
    client = storage_client()
    if client is None:
        raise RuntimeError('Temporary audio storage is not configured')
    return client.generate_presigned_url(
        'put_object', Params={'Bucket': settings.s3_bucket, 'Key': key, 'ContentType': content_type},
        ExpiresIn=settings.audio_ttl_seconds,
    )


def signed_get(key: str, expires_in: int | None = None) -> str:
    client = storage_client()
    if client is None:
        raise RuntimeError('Temporary audio storage is not configured')
    return client.generate_presigned_url(
        'get_object', Params={'Bucket': settings.s3_bucket, 'Key': key},
        ExpiresIn=min(settings.audio_ttl_seconds, expires_in) if expires_in is not None else settings.audio_ttl_seconds,
    )


def delete_objects(keys: list[str]) -> None:
    client = storage_client()
    if client and keys:
        client.delete_objects(Bucket=settings.s3_bucket, Delete={'Objects': [{'Key': key} for key in keys]})


def validate_uploaded_audio(key: str) -> None:
    """Do not advance a turn until a bounded, decodable PCM WAV exists."""
    import io
    import wave

    client = storage_client()
    if client is None:
        raise RuntimeError('Temporary audio storage is not configured')
    metadata = client.head_object(Bucket=settings.s3_bucket, Key=key)
    if not 44 < metadata['ContentLength'] <= 4_000_000:
        raise ValueError('Audio size is invalid')
    response = client.get_object(Bucket=settings.s3_bucket, Key=key)
    body = response['Body']
    try:
        data = body.read(4_000_001)
    finally:
        body.close()
    try:
        with wave.open(io.BytesIO(data), 'rb') as audio:
            if (audio.getnchannels() not in (1, 2) or audio.getsampwidth() != 2
                    or not 8000 <= audio.getframerate() <= 96000
                    or not 0.1 <= audio.getnframes() / audio.getframerate() <= 10):
                raise ValueError('Audio format or duration is invalid')
            expected = audio.getnframes() * audio.getnchannels() * audio.getsampwidth()
            if len(audio.readframes(audio.getnframes())) != expected:
                raise ValueError('Audio is incomplete')
    except (wave.Error, EOFError) as exc:
        raise ValueError('Audio must be a PCM WAV file') from exc
