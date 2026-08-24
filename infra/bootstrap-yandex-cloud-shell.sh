#!/usr/bin/env bash
set -Eeuo pipefail

CLOUD_ID="b1gdd8mvsmaacivqjl15"
FOLDER_ID="b1gtc579k8imd81bb227"
ARCHIVE_URL="https://github.com/vmitin9302-ctrl/easysong-reverse-game/archive/refs/heads/main.tar.gz"
PERSIST_ROOT="${HOME}/.reverse-game-bootstrap"
WORK_ROOT="${TMPDIR:-/tmp}/reverse-game-bootstrap-${USER:-cloudshell}"
REPO_DIR="${WORK_ROOT}/repo"
TF_DIR="${REPO_DIR}/infra/terraform"
TF_MIN_VERSION="1.5.7"
VARS_FILE="${PERSIST_ROOT}/terraform.tfvars"
STATE_FILE="${PERSIST_ROOT}/terraform.tfstate"
OUTPUT_FILE="${PERSIST_ROOT}/reverse-game-outputs.json"

say() { printf '\n\033[1;35m%s\033[0m\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

command -v yc >/dev/null 2>&1 || fail "Yandex Cloud CLI (yc) is not available. Run this script from Yandex Cloud Shell."
command -v terraform >/dev/null 2>&1 || fail "Terraform is not available in this Cloud Shell session."
command -v curl >/dev/null 2>&1 || fail "curl is not available."
command -v tar >/dev/null 2>&1 || fail "tar is not available."
command -v openssl >/dev/null 2>&1 || fail "openssl is not available."

say "EasySong Reverse Game — Yandex Cloud bootstrap"
printf 'Cloud ID : %s\nFolder ID: %s\n' "$CLOUD_ID" "$FOLDER_ID"
printf 'This bootstrap creates paid Yandex Cloud resources only inside this folder.\n'

yc config set cloud-id "$CLOUD_ID" >/dev/null
yc config set folder-id "$FOLDER_ID" >/dev/null

CURRENT_FOLDER="$(yc config get folder-id 2>/dev/null || true)"
[[ "$CURRENT_FOLDER" == "$FOLDER_ID" ]] || fail "yc is not configured for the expected folder."

mkdir -p "$PERSIST_ROOT"

check_terraform() {
  local active_version oldest
  active_version="$(terraform version | head -n 1 | sed 's/^Terraform v//')"
  oldest="$(printf '%s\n%s\n' "$TF_MIN_VERSION" "$active_version" | sort -V | head -n 1)"
  [[ "$oldest" == "$TF_MIN_VERSION" ]] || fail "Terraform ${active_version} is too old; expected ${TF_MIN_VERSION} or newer."
  say "Using Yandex Cloud Shell Terraform ${active_version}"
}

prepare_repository() {
  say "Preparing repository archive"
  rm -rf "$WORK_ROOT"
  mkdir -p "$REPO_DIR" "${WORK_ROOT}/downloads"

  local archive="${WORK_ROOT}/downloads/main.tar.gz"
  curl -fL --retry 3 "$ARCHIVE_URL" -o "$archive"
  tar -xzf "$archive" \
    --strip-components=1 \
    --no-same-owner \
    --no-same-permissions \
    -C "$REPO_DIR"

  [[ -f "${TF_DIR}/main.tf" ]] || fail "Repository archive was downloaded, but Terraform files are missing."
}

sync_state() {
  if [[ -n "${TF_DIR:-}" && -f "${TF_DIR}/terraform.tfstate" ]]; then
    cp "${TF_DIR}/terraform.tfstate" "$STATE_FILE" || true
  fi
  if [[ -n "${TF_DIR:-}" && -f "${TF_DIR}/terraform.tfstate.backup" ]]; then
    cp "${TF_DIR}/terraform.tfstate.backup" "${STATE_FILE}.backup" || true
  fi
}
trap sync_state EXIT

prepare_repository
check_terraform
cd "$TF_DIR"

# Use the current Cloud Shell identity only for the one-time bootstrap.
# The resulting GitHub deployment uses Workload Identity Federation and no long-lived Yandex key.
export YC_TOKEN="$(yc iam create-token)"
export YC_CLOUD_ID="$CLOUD_ID"
export YC_FOLDER_ID="$FOLDER_ID"

if [[ ! -f "$VARS_FILE" ]]; then
  say "Creating local bootstrap secrets"
  printf 'Paste the BotFather token for @easygame7_bot (it will be visible until you press Enter): '
  IFS= read -r TELEGRAM_BOT_TOKEN
  [[ -n "$TELEGRAM_BOT_TOKEN" && "$TELEGRAM_BOT_TOKEN" == *:* ]] || fail "Telegram bot token does not look valid. Nothing was applied."

  printf '\033[3J\033[2J\033[H'
  say "Telegram token accepted. Continuing securely."

  DB_PASSWORD="$(openssl rand -hex 24)"
  SESSION_SECRET="$(openssl rand -hex 32)"
  BUCKET_SUFFIX="$(openssl rand -hex 3)"
  WEB_BUCKET="easygame7-${FOLDER_ID: -8}-${BUCKET_SUFFIX}"
  AUDIO_BUCKET="easygame7-audio-${FOLDER_ID: -8}-${BUCKET_SUFFIX}"

  umask 077
  cat > "$VARS_FILE" <<EOF
cloud_id                 = "${CLOUD_ID}"
folder_id                = "${FOLDER_ID}"
web_bucket_name          = "${WEB_BUCKET}"
audio_bucket_name        = "${AUDIO_BUCKET}"
db_password              = "${DB_PASSWORD}"
session_secret           = "${SESSION_SECRET}"
telegram_bot_token       = "${TELEGRAM_BOT_TOKEN}"
EOF
  unset TELEGRAM_BOT_TOKEN DB_PASSWORD SESSION_SECRET
else
  say "Existing private bootstrap secrets found; reusing them for an idempotent retry"
fi

# Older bootstrap runs stored an unused Yandex Telegram webhook input.
sed -i '/^[[:space:]]*telegram_webhook_secret[[:space:]]*=/d' "$VARS_FILE"

if ! grep -q '^[[:space:]]*audio_bucket_name[[:space:]]*=' "$VARS_FILE"; then
  BUCKET_SUFFIX="$(openssl rand -hex 3)"
  printf 'audio_bucket_name        = "easygame7-audio-%s-%s"\n' "${FOLDER_ID: -8}" "$BUCKET_SUFFIX" >> "$VARS_FILE"
fi

WEB_BUCKET="$(awk -F'"' '/^[[:space:]]*web_bucket_name[[:space:]]*=/{print $2; exit}' "$VARS_FILE")"
[[ -n "$WEB_BUCKET" ]] || fail "Could not read web_bucket_name from private terraform.tfvars."
AUDIO_BUCKET="$(awk -F'"' '/^[[:space:]]*audio_bucket_name[[:space:]]*=/{print $2; exit}' "$VARS_FILE")"
[[ -n "$AUDIO_BUCKET" ]] || fail "Could not read audio_bucket_name from private terraform.tfvars."

cp "$VARS_FILE" terraform.tfvars
if [[ -f "$STATE_FILE" ]]; then
  say "Existing Terraform state found; restoring it for a safe retry"
  cp "$STATE_FILE" terraform.tfstate
fi

say "Validating infrastructure"
terraform init -input=false
terraform fmt -check -recursive
terraform validate
terraform plan -input=false -out=bootstrap.tfplan

printf '\nTerraform plan is ready. Creating Managed PostgreSQL and other cloud resources can incur charges.\n'
printf 'Type APPLY to create the resources, or anything else to stop: '
IFS= read -r CONFIRM
if [[ "${CONFIRM^^}" != "APPLY" ]]; then
  printf 'Stopped before terraform apply. You can rerun this same script later; private values remain only in your Cloud Shell home.\n'
  exit 0
fi

say "Creating remaining Yandex Cloud resources"
terraform apply -input=false bootstrap.tfplan
sync_state

ensure_web_bucket() {
  say "Ensuring Object Storage website bucket"

  if yc storage bucket get --name "$WEB_BUCKET" --folder-id "$FOLDER_ID" >/dev/null 2>&1; then
    printf 'Bucket %s already exists; updating public/website settings.\n' "$WEB_BUCKET"
  else
    yc storage bucket create \
      --name "$WEB_BUCKET" \
      --folder-id "$FOLDER_ID" \
      --public-read \
      --public-list \
      --tags project=reverse-game,environment=production,managed_by=bootstrap \
      >/dev/null
  fi

  yc storage bucket update \
    --name "$WEB_BUCKET" \
    --folder-id "$FOLDER_ID" \
    --public-read \
    --public-list \
    --tags project=reverse-game,environment=production,managed_by=bootstrap \
    --website-settings '{"index":"index.html","error":"index.html"}' \
    >/dev/null

  yc storage bucket get --name "$WEB_BUCKET" --folder-id "$FOLDER_ID" >/dev/null
  printf 'Object Storage website bucket ready: %s\n' "$WEB_BUCKET"
}

ensure_web_bucket

ensure_audio_bucket() {
  say "Ensuring private temporary-audio bucket"
  if ! yc storage bucket get --name "$AUDIO_BUCKET" --folder-id "$FOLDER_ID" >/dev/null 2>&1; then
    yc storage bucket create \
      --name "$AUDIO_BUCKET" \
      --folder-id "$FOLDER_ID" \
      --tags project=reverse-game,purpose=temporary-duel-audio,managed_by=bootstrap \
      >/dev/null
  fi
  local website_origin="https://${WEB_BUCKET}.website.yandexcloud.net"
  local configured_origin="${PUBLIC_WEB_URL:-$website_origin}"
  configured_origin="${configured_origin%/}"
  [[ "$configured_origin" =~ ^https://[^/]+$ ]] || fail "PUBLIC_WEB_URL must be an HTTPS origin without a path."
  local allowed_origins="[${website_origin}]"
  if [[ "$configured_origin" != "$website_origin" ]]; then
    allowed_origins="[${website_origin},${configured_origin}]"
  fi
  yc storage bucket update \
    --name "$AUDIO_BUCKET" \
    --folder-id "$FOLDER_ID" \
    --cors allowed-methods='[method-get,method-put,method-head]',allowed-origins="${allowed_origins}",allowed-headers='[content-type]',expose-headers='[etag]',max-age-seconds=600 \
    --lifecycle-rules-from-file "${REPO_DIR}/infra/audio-lifecycle.json" \
    >/dev/null
  yc storage bucket get --name "$AUDIO_BUCKET" --folder-id "$FOLDER_ID" >/dev/null
  printf 'Private temporary-audio bucket ready with CORS and lifecycle cleanup: %s\n' "$AUDIO_BUCKET"
}

ensure_audio_bucket
terraform output -json > "$OUTPUT_FILE"

say "Bootstrap completed"
printf 'Non-secret output file: %s\n\n' "$OUTPUT_FILE"
terraform output

cat <<'EOF'

NEXT STEP:
Send ChatGPT ONLY the `terraform output` text shown above (or a screenshot of it).
Do NOT send terraform.tfvars, terraform.tfstate, the Telegram token, database password, or any Lockbox payload.
EOF
