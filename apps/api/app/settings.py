from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')

    database_url: str | None = None
    easysong_url: str = 'https://easysong.ru/webapp/auth?next=%2Fwebapp'
    allowed_origins: str = 'http://localhost:5173'


settings = Settings()
