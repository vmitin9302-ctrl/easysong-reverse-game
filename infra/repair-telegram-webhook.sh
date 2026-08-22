#!/usr/bin/env bash
set -Eeuo pipefail

FOLDER_ID="b1gtc579k8imd81bb227"
LOCKBOX_SECRET_ID="e6qa23qqickfuqekoojj"
BOT_CONTAINER_NAME="reverse-game-bot"

say() { printf '\n\033[1;35m%s\033[0m\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

command -v yc >/dev/null 2>&1 || fail "yc CLI is required. Run this from Yandex Cloud Shell."
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v jq >/dev/null 2>&1 || fail "jq is required."

yc config set folder-id "$FOLDER_ID" >/dev/null

say "Resolving deployed Telegram bot container"
container_json="$(yc serverless container get --name "$BOT_CONTAINER_NAME" --folder-id "$FOLDER_ID" --format json)"
bot_id="$(printf '%s' "$container_json" | jq -r '.id // empty')"
bot_url="$(printf '%s' "$container_json" | jq -r '.url // empty')"
[[ -n "$bot_id" ]] || fail "Could not resolve reverse-game-bot container ID."
if [[ -z "$bot_url" ]]; then
  bot_url="https://${bot_id}.containers.yandexcloud.net"
fi
bot_url="${bot_url%/}"
webhook_url="${bot_url}/telegram/webhook"

say "Reading Telegram credentials from Yandex Lockbox"
telegram_token="$(yc lockbox payload get --id "$LOCKBOX_SECRET_ID" --key TELEGRAM_BOT_TOKEN)"
webhook_secret="$(yc lockbox payload get --id "$LOCKBOX_SECRET_ID" --key TELEGRAM_WEBHOOK_SECRET)"
[[ -n "$telegram_token" ]] || fail "TELEGRAM_BOT_TOKEN is empty in Lockbox."
[[ -n "$webhook_secret" ]] || fail "TELEGRAM_WEBHOOK_SECRET is empty in Lockbox."

say "Warming bot container"
curl --fail --silent --show-error --max-time 20 "${bot_url}/health" >/dev/null || true

say "Registering Telegram webhook"
set_response="$(curl --fail --silent --show-error --max-time 30 \
  -X POST "https://api.telegram.org/bot${telegram_token}/setWebhook" \
  --data-urlencode "url=${webhook_url}" \
  --data-urlencode "secret_token=${webhook_secret}" \
  --data-urlencode 'allowed_updates=["message"]' \
  --data-urlencode 'drop_pending_updates=false')"

set_ok="$(printf '%s' "$set_response" | jq -r '.ok // false')"
if [[ "$set_ok" != "true" ]]; then
  printf '%s\n' "$set_response" | jq . >&2 || true
  fail "Telegram rejected setWebhook."
fi

say "Verifying Telegram webhook"
info="$(curl --fail --silent --show-error --max-time 30 \
  "https://api.telegram.org/bot${telegram_token}/getWebhookInfo")"
actual_url="$(printf '%s' "$info" | jq -r '.result.url // empty')"
pending="$(printf '%s' "$info" | jq -r '.result.pending_update_count // 0')"
last_error="$(printf '%s' "$info" | jq -r '.result.last_error_message // empty')"

unset telegram_token webhook_secret set_response info

[[ "$actual_url" == "$webhook_url" ]] || fail "Webhook verification failed. Expected ${webhook_url}, got ${actual_url:-<empty>}."

printf 'Container: %s\n' "$bot_id"
printf 'Webhook: %s\n' "$actual_url"
printf 'Pending updates: %s\n' "$pending"
if [[ -n "$last_error" ]]; then
  printf 'Previous Telegram delivery error: %s\n' "$last_error"
fi

say "Telegram webhook is registered. Send /start to @easygame7_bot now."
