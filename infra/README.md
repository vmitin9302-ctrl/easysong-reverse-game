# Yandex Cloud — Reverse Game

Production разворачивается только в отдельной папке Yandex Cloud. У service accounts игры нет причин иметь права на BOTYARA, EasySong или любые другие проекты.

## Что создаёт Terraform

`infra/terraform` описывает собственные ресурсы игры:

- приватную VPC/subnet;
- `reverse-game-deploy` — identity для GitHub Actions;
- `reverse-game-runtime` — runtime identity контейнеров;
- GitHub OIDC Workload Identity Federation без долгоживущего JSON-ключа;
- Container Registry;
- Cloud Logging group;
- public Object Storage bucket со SPA hosting;
- отдельный Managed PostgreSQL 17 без публичного IP;
- отдельную БД и пользователя;
- Lockbox secret с `DATABASE_URL`, `SESSION_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`.

## Первый URL без собственного домена

Кастомный DNS не блокирует первый запуск.

Если GitHub variable `PUBLIC_WEB_URL` не задана, deploy workflow использует:

`https://<YC_WEB_BUCKET>.website.yandexcloud.net`

Если `PUBLIC_API_URL` не задана, frontend собирается с прямым HTTPS URL публичного Serverless Container:

`https://<API_CONTAINER_ID>.containers.yandexcloud.net`

После проверки MVP можно без изменения кода подключить `game.easysong.ru`, CDN и Certificate Manager и задать `PUBLIC_WEB_URL` / `PUBLIC_API_URL`.

## Секреты

Никогда не коммитить:

- Telegram bot token;
- Telegram webhook secret;
- PostgreSQL password;
- session secret;
- `terraform.tfvars`;
- Terraform state;
- статические ключи Yandex Cloud.

Lockbox version создаётся через `yandex_lockbox_secret_version_hashed`, поэтому payload values в resource state представлены hash-значениями. При этом сам Terraform state всё равно считается чувствительным и должен храниться защищённо.

## Bootstrap

1. В Yandex Cloud должна существовать отдельная folder для игры и активный billing account.
2. Скопировать `infra/terraform/terraform.tfvars.example` в локальный `terraform.tfvars` и заполнить Cloud ID, Folder ID, уникальное имя bucket и секретные значения.
3. Выполнить `terraform init`, `terraform plan`, затем `terraform apply` под учётной записью, имеющей права создавать ресурсы и IAM bindings в этой отдельной folder.
4. Взять значения из `terraform output` и добавить их как GitHub repository variables: `YC_SA_ID`, `YC_FOLDER_ID`, `YC_REGISTRY_ID`, `YC_RUNTIME_SA_ID`, `YC_NETWORK_ID`, `YC_LOCKBOX_SECRET_ID`, `YC_LOG_GROUP_ID`, `YC_WEB_BUCKET`.
5. После этого `.github/workflows/deploy-yandex.yml` делает остальные deploy-шаги автоматически через GitHub OIDC: собирает images, публикует containers, собирает web с реальным API URL, загружает сайт и второй ревизией бота автоматически устанавливает Telegram webhook на его собственный Serverless Container URL.

Никакой Yandex authorized-key JSON в GitHub Secrets не требуется.

## Telegram

Нужен новый самостоятельный bot token именно для Reverse Game. Он помещается в Terraform input/Lockbox, но не в Git.

После deploy бот получает:

- `TELEGRAM_WEBAPP_URL` — HTTPS URL игры;
- `TELEGRAM_WEBHOOK_URL` — автоматически вычисленный `https://<bot_container_id>.containers.yandexcloud.net/telegram/webhook`;
- `TELEGRAM_WEBHOOK_SECRET` — из Lockbox.

## Custom domain — после MVP

Финальная схема может быть:

- `game.easysong.ru` → Object Storage/CDN;
- `api.game.easysong.ru` → API/API Gateway;
- Certificate Manager → TLS;
- DNS record → соответствующий Yandex Cloud endpoint.

Это отдельный инфраструктурный слой и не требует переделки frontend/audio engine/backend.
