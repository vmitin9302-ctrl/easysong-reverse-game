#!/usr/bin/env bash
set -Eeuo pipefail

CLOUD_ID="b1gdd8mvsmaacivqjl15"
FOLDER_ID="b1gtc579k8imd81bb227"
ARCHIVE_URL="https://github.com/vmitin9302-ctrl/easysong-reverse-game/archive/refs/heads/main.tar.gz"
WORK_ROOT="${TMPDIR:-/tmp}/reverse-game-bootstrap-${USER:-cloudshell}"
SOURCE_DIR="${WORK_ROOT}/source"
TF_DIR="${WORK_ROOT}/terraform"
BIN_DIR="${WORK_ROOT}/bin"
TF_VERSION="1.13.2"

say() { printf '\n\033[1;35m%s\033[0m\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

command -v yc >/dev/null 2>&1 || fail "Yandex Cloud CLI (yc) is not available. Run this script from Yandex Cloud Shell."
command -v curl >/dev/null 2>&1 || fail "curl is not available."
command -v tar >/dev/null 2>&1 || fail "tar is not available."
command -v unzip >/dev/null 2>&1 || fail "unzip is not available."
command -v openssl >/dev/null 2>&1 || fail "openssl is not available."

say "EasySong Reverse Game — Yandex Cloud bootstrap"
printf 'Cloud ID : %s\nFolder ID: %s\n' "$CLOUD_ID" "$FOLDER_ID"
printf 'This bootstrap creates paid Yandex Cloud resources only inside this folder.\n'
printf 'Cloud Shell note: temporary working files are stored under %s to avoid home-filesystem chmod restrictions.\n' "$WORK_ROOT"

yc config set cloud-id "$CLOUD_ID" >/dev/null
yc config set folder-id "$FOLDER_ID" >/dev/null

CURRENT_FOLDER="$(yc config get folder-id 2>/dev/null || true)"
[[ "$CURRENT_FOLDER" == "$FOLDER_ID" ]] || fail "yc is not configured for the expected folder."

mkdir -p "$WORK_ROOT" "$BIN_DIR" "$TF_DIR"

install_terraform() {
  if command -v terraform >/dev/null 2>&1; then
    return
  fi

  say "Terraform is not installed; installing a local copy ${TF_VERSION} into ${BIN_DIR}"
  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) fail "Unsupported architecture: $(uname -m)" ;;
  esac

  local zip="${WORK_ROOT}/terraform_${TF_VERSION}_linux_${arch}.zip"
  curl -fL --retry 3 \
    "https://releases.hashicorp.com/terraform/${TF_VERSION}/terraform_${TF_VERSION}_linux_${arch}.zip" \
    -o "$zip"
  unzip -oq "$zip" -d "$BIN_DIR"
  chmod +x "${BIN_DIR}/terraform"
  export PATH="${BIN_DIR}:${PATH}"
}

install_terraform

say "Preparing repository snapshot"
rm -rf "$SOURCE_DIR"
mkdir -p "$SOURCE_DIR"
ARCHIVE_FILE="${WORK_ROOT}/repo-main.tar.gz"
curl -fL --retry 3 "$ARCHIVE_URL" -o "$ARCHIVE_FILE"
tar -xzf "$ARCHIVE_FILE" -C "$SOURCE_DIR" --strip-components=1

# Refresh Terraform source files while preserving retry-local terraform.tfvars/state in /tmp.
find "$TF_DIR" -maxdepth 1 -type f -name '*.tf' -delete
cp "$SOURCE_DIR"/infra/terraform/*.tf "$TF_DIR"/
cp "$SOURCE_DIR"/infra/terraform/terraform.tfvars.example "$TF_DIR"/terraform.tfvars.example

cd "$TF_DIR"

# Use the current Cloud Shell identity only for the one-time bootstrap.
# The resulting GitHub deployment uses Workload Identity Federation and no long-lived Yandex key.
export YC_TOKEN="$(yc iam create-token)"
export YC_CLOUD_ID="$CLOUD_ID"
export YC_FOLDER_ID="$FOLDER_ID"

if [[ ! -f terraform.tfvars ]]; then
  say "Creating local bootstrap secrets"
  printf 'Paste the BotFather token for @easygame7_bot (input is hidden): '
  IFS= read -r -s TELEGRAM_BOT_TOKEN
  printf '\n'
  [[ -n "$TELEGRAM_BOT_TOKEN" && "$TELEGRAM_BOT_TOKEN" == *:* ]] || fail "Telegram bot token does not look valid. Nothing was applied."

  DB_PASSWORD="$(openssl rand -hex 24)"
  SESSION_SECRET="$(openssl rand -hex 32)"
  WEBHOOK_SECRET="$(openssl rand -hex 32)"
  BUCKET_SUFFIX="$(openssl rand -hex 3)"
  WEB_BUCKET="easygame7-${FOLDER_ID: -8}-${BUCKET_SUFFIX}"

  umask 077
  cat > terraform.tfvars <<EOF
cloud_id                = "${CLOUD_ID}"
folder_id               = "${FOLDER_ID}"
web_bucket_name         = "${WEB_BUCKET}"
db_password             = "${DB_PASSWORD}"
session_secret          = "${SESSION_SECRET}"
telegram_bot_token      = "${TELEGRAM_BOT_TOKEN}"
telegram_webhook_secret = "${WEBHOOK_SECRET}"
EOF
  unset TELEGRAM_BOT_TOKEN DB_PASSWORD SESSION_SECRET WEBHOOK_SECRET
else
  say "Existing private terraform.tfvars found in this Cloud Shell session; reusing it for an idempotent retry"
fi

say "Validating infrastructure"
terraform init -input=false
terraform fmt -check -recursive
terraform validate
terraform plan -input=false -out=bootstrap.tfplan

printf '\nTerraform plan is ready. Creating Managed PostgreSQL and other cloud resources can incur charges.\n'
printf 'Keep this Cloud Shell session open until apply finishes; the one-time bootstrap state is stored in /tmp.\n'
printf 'Type APPLY to create the resources, or anything else to stop: '
IFS= read -r CONFIRM
if [[ "$CONFIRM" != "APPLY" ]]; then
  printf 'Stopped before terraform apply. You can rerun this same script in the current Cloud Shell session.\n'
  exit 0
fi

say "Creating Yandex Cloud resources — PostgreSQL may take several minutes"
terraform apply -input=false bootstrap.tfplan

OUTPUT_FILE="${WORK_ROOT}/reverse-game-outputs.json"
terraform output -json > "$OUTPUT_FILE"

say "Bootstrap completed"
printf 'Non-secret output file: %s\n\n' "$OUTPUT_FILE"
terraform output

cat <<'EOF'

NEXT STEP:
Send ChatGPT ONLY the `terraform output` text shown above (or a screenshot of it).
Do NOT send terraform.tfvars, terraform.tfstate, the Telegram token, database password, or any Lockbox payload.
EOF
