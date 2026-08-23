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
        config=Config(signature_version='s3v4'),
    )


def signed_put(key: str, content_type: str) -> str:
    client = storage_client()
    if client is None:
        raise RuntimeError('Temporary audio storage is not configured')
    return client.generate_presigned_url(
        'put_object', Params={'Bucket': settings.s3_bucket, 'Key': key, 'ContentType': content_type},
        ExpiresIn=settings.audio_ttl_seconds,
    )


def signed_get(key: str) -> str:
    client = storage_client()
    if client is None:
        raise RuntimeError('Temporary audio storage is not configured')
    return client.generate_presigned_url(
        'get_object', Params={'Bucket': settings.s3_bucket, 'Key': key},
        ExpiresIn=settings.audio_ttl_seconds,
    )


def delete_objects(keys: list[str]) -> None:
    client = storage_client()
    if client and keys:
        client.delete_objects(Bucket=settings.s3_bucket, Delete={'Objects': [{'Key': key} for key in keys]})
