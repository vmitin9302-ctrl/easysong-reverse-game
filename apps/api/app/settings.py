from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')

    database_url: str | None = None
    easysong_url: str = 'https://easysong.ru/webapp/auth?next=%2Fwebapp'
    allowed_origins: str = 'http://localhost:5173'
    session_secret: str = 'development-only-change-me'
    telegram_bot_token: str | None = None
    analytics_admin_token: str | None = None
    analytics_ingest_token: str | None = None
    analytics_admin_username: str | None = None
    analytics_admin_password: str | None = None
    s3_endpoint_url: str = 'https://storage.yandexcloud.net'
    s3_region: str = 'ru-central1'
    s3_bucket: str | None = None
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None
    audio_ttl_seconds: int = Field(default=1200, ge=60, le=86_400)
    invite_ttl_seconds: int = Field(default=1800, ge=300, le=86_400)


settings = Settings()
