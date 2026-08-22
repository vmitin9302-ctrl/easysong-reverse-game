# EasySong Reverse Game

Самостоятельная браузерная игра «Скажи наоборот» для привлечения аудитории в EasySong.

## Принципы

- полностью отдельный проект, без зависимостей от кода BOTYARA или EasySong;
- один web-клиент работает как обычный сайт и как Telegram Mini App;
- голосовые записи обрабатываются локально на устройстве и не загружаются на сервер;
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

## Безопасность

Никогда не коммитить `.env`, токены Telegram, ключи Yandex Cloud или доступы к PostgreSQL. Для production секреты будут храниться в Yandex Lockbox.
