# Yandex Cloud — Reverse Game

Production разворачивается только в отдельной папке Yandex Cloud. У service accounts игры нет причин иметь права на BOTYARA, EasySong или любые другие проекты.

## Что создаёт Terraform

`infra/terraform` и Cloud Shell bootstrap описывают собственные ресурсы игры:

- приватную VPC/subnet;
- `reverse-game-deploy` — identity для GitHub Actions;
- `reverse-game-runtime` — runtime identity контейнеров;
- GitHub OIDC Workload Identity Federation без долгоживущего JSON-ключа;
- Container Registry;
- Cloud Logging group;
- public Object Storage bucket со SPA hosting и отдельный приватный bucket временного аудио (оба создаёт bootstrap через `yc`);
- отдельный Managed PostgreSQL 17 без публичного IP;
- отдельную БД и пользователя;
- Lockbox secret с `DATABASE_URL`, `SESSION_SECRET`, `TELEGRAM_BOT_TOKEN` и приватными S3 credentials.

## Первый URL без собственного домена

Кастомный DNS не блокирует первый запуск.

Если GitHub variable `PUBLIC_WEB_URL` не задана, deploy workflow использует:

`https://<YC_WEB_BUCKET>.website.yandexcloud.net`

Если `PUBLIC_API_URL` не задана, frontend собирается с прямым HTTPS URL публичного Serverless Container:

`https://<API_CONTAINER_ID>.containers.yandexcloud.net`

После проверки MVP можно без изменения кода подключить `game.easysong.ru`, CDN и Certificate Manager и задать `PUBLIC_WEB_URL` / `PUBLIC_API_URL`. Перед переключением web URL повторно примените настройку audio bucket с `PUBLIC_WEB_URL=https://game.easysong.ru`, чтобы новый origin появился в CORS.

## Секреты

Никогда не коммитить:

- Telegram bot token;
- PostgreSQL password;
- session secret;
- `terraform.tfvars`;
- Terraform state;
- статические ключи Yandex Cloud.

Lockbox version создаётся через `yandex_lockbox_secret_version_hashed`, поэтому payload Lockbox в state хранится в hash-представлении. Но PostgreSQL credentials и другая чувствительная инфраструктурная информация всё равно могут присутствовать в Terraform state через другие resources. Поэтому весь state нужно считать секретом и хранить только в защищённом backend/локальном окружении, а не в Git.

## Bootstrap

1. В Yandex Cloud должна существовать отдельная folder для игры и активный billing account.
2. Рекомендуемый путь — запустить `infra/bootstrap-yandex-cloud-shell.sh` в Yandex Cloud Shell: он создаст приватный `terraform.tfvars`, выполнит `terraform init/plan/apply`, затем идемпотентно создаст и настроит оба bucket через `yc`.
3. При ручном запуске Terraform после `terraform apply` отдельно создайте website/audio buckets и примените к audio bucket CORS и `infra/audio-lifecycle.json`; Terraform намеренно не управляет Object Storage в этом проекте.
4. Взять значения из `terraform output` и добавить их как GitHub repository variables: `YC_SA_ID`, `YC_FOLDER_ID`, `YC_REGISTRY_ID`, `YC_RUNTIME_SA_ID`, `YC_NETWORK_ID`, `YC_LOCKBOX_SECRET_ID`, `YC_LOG_GROUP_ID`, `YC_WEB_BUCKET`.
5. После этого `.github/workflows/deploy-yandex.yml` через GitHub OIDC проверяет тесты, публикует только API и Web, а затем запускает production duel smoke test. Telegram-бот этим workflow не разворачивается.

Никакой Yandex authorized-key JSON в GitHub Secrets не требуется.

## Telegram

Нужен самостоятельный bot token именно для Reverse Game. API получает его из Lockbox только для проверки Telegram `initData`; сам бот получает token в Railway и работает исключительно через long polling.

Railway service получает:

- `TELEGRAM_WEBAPP_URL` — HTTPS URL игры;
- `TELEGRAM_BOT_TOKEN` — BotFather token.

Yandex Cloud не содержит Telegram poller, webhook, gateway или fallback delivery.

Приватный audio bucket должен иметь CORS только для production web origin (`GET`, `PUT`, `HEAD`, заголовок `Content-Type`) и lifecycle-правило аварийного удаления `matches/` через один день. Bootstrap применяет обе настройки идемпотентно из `infra/audio-lifecycle.json`; signed URL всё равно истекает примерно через 20 минут, а API удаляет объекты сразу после текстовой догадки или forfeit.

## Custom domain — после MVP

Финальная схема может быть:

- `game.easysong.ru` → Object Storage/CDN;
- `api.game.easysong.ru` → API/API Gateway;
- Certificate Manager → TLS;
- DNS record → соответствующий Yandex Cloud endpoint.

Это отдельный инфраструктурный слой и не требует переделки frontend/audio engine/backend.
