# EasySong Reverse Game

Самостоятельная браузерная игра «Скажи наоборот» для привлечения аудитории в EasySong.

## Принципы

- полностью отдельный проект, без зависимостей от кода BOTYARA или EasySong;
- один web-клиент работает как обычный сайт и как Telegram Mini App;
- два режима дуэли: передача одного телефона и приватная комната по invite URL;
- оригинал загадчика и scoring остаются локальными; между устройствами временно передаются только перевёрнутый challenge и попытка;
- переход в EasySong — только через внешний CTA с измеримой атрибуцией;
- production-инфраструктура планируется в отдельном контуре Yandex Cloud.

## Структура

```text
apps/web           React + TypeScript + Vite
apps/api           FastAPI backend
apps/telegram-bot  отдельный Telegram bot
packages/audio-engine  локальная обработка и scoring аудио
infra              заготовки инфраструктуры Yandex Cloud
```

## Быстрый старт web

```bash
npm install
npm run dev:web
```

Web-приложение по умолчанию откроется на `http://localhost:5173`.

## Локальная разработка backend

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
# Linux/macOS: source .venv/bin/activate
pip install -r apps/api/requirements.txt
uvicorn apps.api.app.main:app --reload --port 8000
```

## Cross-device протокол и безопасность

1. Загадчик локально сохраняет оригинал, переворачивает его и загружает только WAV с перевёрнутым звуком.
2. Соперник скачивает клип по короткоживущему signed GET, записывает попытку и временно загружает её.
3. Устройство загадчика скачивает попытку, локально разворачивает и сравнивает с оригиналом. API получает только score и breakdown.
4. После score API удаляет оба объекта. Bucket должен иметь lifecycle-правило удаления объектов с префиксом `matches/` максимум через сутки как аварийную страховку; подписанные URL и metadata истекают через `AUDIO_TTL_SECONDS` (по умолчанию 20 минут).

Object Storage обязан быть приватным: без website hosting и public ACL. Для runtime задаются `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Для production примените `apps/api/migrations/001_duel_matches.sql`; `create_all` остаётся удобством для пустого стенда.

Telegram-бот развёрнут отдельно на Railway в режиме long polling. Дуэльный релиз не меняет его runtime и не возвращает webhook/function в Yandex Cloud; сайт, API, PostgreSQL и временный bucket остаются в Yandex Cloud.

## Безопасность

Никогда не коммитить `.env`, токены Telegram, ключи Yandex Cloud или доступы к PostgreSQL. Для production секреты будут храниться в Yandex Lockbox.
