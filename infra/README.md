# Yandex Cloud deployment plan

Production разворачивается в отдельной папке Yandex Cloud, не связанной IAM-правами с другими проектами.

## Целевые ресурсы

- `reverse-game-web` — Object Storage bucket для `apps/web/dist`.
- `reverse-game-cdn` — CDN для `game.easysong.ru`.
- `reverse-game-api` — Serverless Container из `apps/api/Dockerfile`.
- `reverse-game-bot` — отдельный Serverless Container из `apps/telegram-bot/Dockerfile`.
- `reverse-game-postgres` — отдельный Managed PostgreSQL.
- `reverse-game-registry` — Container Registry.
- `reverse-game-lockbox` — Lockbox secrets для DB/Telegram/session secret.
- `reverse-game-logs` — отдельная log group.
- Certificate Manager — TLS для `game.easysong.ru` и `api.game.easysong.ru`.

## Домены

- `game.easysong.ru` → статический frontend через CDN.
- `api.game.easysong.ru` → API container.
- Telegram webhook указывает на отдельный публичный HTTPS endpoint bot container.

## Секреты

В GitHub и Docker images запрещено хранить:

- `TELEGRAM_BOT_TOKEN`;
- `TELEGRAM_WEBHOOK_SECRET`;
- `DATABASE_URL` / пароль БД;
- `SESSION_SECRET`;
- статические ключи Yandex Cloud.

Production-значения передаются контейнерам из Lockbox.

## Развёртывание

1. Создать отдельную folder `reverse-game-prod`.
2. Создать отдельный service account с минимальными ролями только в этой folder.
3. Создать PostgreSQL и приватную сеть для backend.
4. Создать Container Registry, собрать и загрузить API и Telegram images.
5. Создать Serverless Containers и подключить Lockbox secrets.
6. Собрать web (`npm run build`) и загрузить `apps/web/dist` в Object Storage.
7. Подключить CDN и сертификаты.
8. Настроить DNS.
9. Установить `VITE_API_BASE_URL=https://api.game.easysong.ru` при production build.
10. Установить Telegram Mini App URL `https://game.easysong.ru` и webhook.

До появления production Cloud ID / Folder ID / DNS-доступа инфраструктурный код не должен содержать фиктивные идентификаторы.
