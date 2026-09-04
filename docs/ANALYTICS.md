# First-party analytics

Аналитика работает без внешних SDK и трекеров. Браузер создаёт случайный anonymous id в localStorage; Telegram chat id никогда не отправляется и перед отправкой превращается в необратимый HMAC. IP, user-agent fingerprint, тексты фраз/ответов и аудио не сохраняются.

## Основные события

| Event | Trigger | Important fields |
|---|---|---|
| `page_viewed` | создана backend-сессия страницы | page, source, anonymous_id |
| `element_clicked` | click по button/a | page, section, element, action |
| `duel_mode_selected` | выбран локальный режим | mode |
| `local_duel_started` / `online_duel_started` | запущен режим | mode |
| `game_started` / `game_completed` | начало/финал игры | mode, round |
| `match_created` / `match_joined` / `match_resumed` | online-room lifecycle | mode |
| `easysong_clicked` | CTA EasySong | section/element через общий click |
| `telegram_banner_clicked` | footer Telegram CTA | section, element, action |
| `bot_started` / `bot_restarted` | `/start` в Railway-боте | anonymous_id, source |
| `bot_check_clicked` / `bot_game_opened` | Mini App открылась из кнопки бота | source |

`bot_check_clicked` измеряется в момент фактического открытия Web App: Telegram не отправляет callback для `web_app`-кнопки. Поэтому этот показатель одновременно является надёжным числом переходов в игру, а не показом кнопки.

## API

- `POST /v1/events` и `/v1/events/batch` — public browser ingestion, payload ограничен Pydantic-схемой.
- `POST /v1/bot/events` — server-to-server ingestion, требует `X-Analytics-Token`.
- `GET /v1/admin/analytics?days=30` — private JSON report, требует `Authorization: Bearer …`; `days` от 1 до 366.
- `/stats` — адаптивная панель с логином, итогами, дневным графиком и таблицами. Вход создаёт защищённую HttpOnly-сессию на 12 часов через `POST /v1/admin/login`; выход — `POST /v1/admin/logout`.

Отчёт содержит totals, counts по каждому событию, top-20 элементов и дневную разбивку событий/сессий. Ключи должны быть разными, случайными и храниться только в Yandex Lockbox / Railway Variables.
Логин и пароль панели задаются только через `ANALYTICS_ADMIN_USERNAME` и `ANALYTICS_ADMIN_PASSWORD`; их нельзя добавлять в репозиторий.

## Миграция и откат

`005_first_party_analytics.sql` добавляет nullable-поля и два индекса, не переписывая существующие события. Команды ручного отката приведены в самой миграции; откат удалит только новые колонки и индексы, поэтому перед ним следует экспортировать аналитику, если она нужна.
