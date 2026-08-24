locals {
  labels = {
    project     = "reverse-game"
    environment = "production"
    managed_by  = "terraform"
  }

  deploy_roles = toset([
    "storage.editor",
    "container-registry.images.pusher",
    "serverless-containers.admin",
    "iam.serviceAccounts.user",
    "vpc.user",
    "functions.editor",
    "lockbox.viewer",
    "lockbox.payloadViewer",
    "logging.editor",
    "logging.writer",
  ])

  runtime_roles = toset([
    "container-registry.images.puller",
    "lockbox.payloadViewer",
    "logging.writer",
    "storage.editor",
  ])

  database_url = "postgresql+psycopg://${var.db_user}:${urlencode(var.db_password)}@${yandex_mdb_postgresql_cluster_v2.postgres.hosts["primary"].fqdn}:6432/${var.db_name}?sslmode=require"
}

resource "yandex_vpc_network" "reverse_game" {
  name        = "reverse-game-network"
  description = "Isolated network for EasySong Reverse Game only"
  folder_id   = var.folder_id
  labels      = local.labels
}

resource "yandex_vpc_subnet" "reverse_game" {
  name           = "reverse-game-subnet"
  description    = "Private subnet for reverse-game runtime and PostgreSQL"
  folder_id      = var.folder_id
  zone           = var.zone
  network_id     = yandex_vpc_network.reverse_game.id
  v4_cidr_blocks = [var.subnet_cidr]
  labels         = local.labels
}

resource "yandex_iam_service_account" "deploy" {
  name        = "reverse-game-deploy"
  description = "GitHub Actions deploy identity for reverse-game only"
  folder_id   = var.folder_id
  labels      = local.labels
}

resource "yandex_iam_service_account" "runtime" {
  name        = "reverse-game-runtime"
  description = "Runtime identity for reverse-game Serverless Containers"
  folder_id   = var.folder_id
  labels      = local.labels
}

resource "yandex_resourcemanager_folder_iam_member" "deploy_roles" {
  for_each = local.deploy_roles

  folder_id = var.folder_id
  role      = each.value
  member    = "serviceAccount:${yandex_iam_service_account.deploy.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "runtime_roles" {
  for_each = local.runtime_roles

  folder_id = var.folder_id
  role      = each.value
  member    = "serviceAccount:${yandex_iam_service_account.runtime.id}"
}

resource "yandex_iam_workload_identity_oidc_federation" "github" {
  name        = "reverse-game-github"
  folder_id   = var.folder_id
  description = "Keyless GitHub Actions authentication for reverse-game"
  disabled    = false
  audiences   = ["https://github.com/${var.github_owner}"]
  issuer      = "https://token.actions.githubusercontent.com"
  jwks_url    = "https://token.actions.githubusercontent.com/.well-known/jwks"
  labels      = local.labels
}

resource "yandex_iam_workload_identity_federated_credential" "github_main" {
  service_account_id  = yandex_iam_service_account.deploy.id
  federation_id       = yandex_iam_workload_identity_oidc_federation.github.id
  external_subject_id = "repo:${var.github_owner}@${var.github_owner_id}/${var.github_repository}@${var.github_repository_id}:ref:refs/heads/main"
}

resource "yandex_container_registry" "reverse_game" {
  name      = "reverse-game-registry"
  folder_id = var.folder_id
  labels    = local.labels
}

resource "yandex_logging_group" "reverse_game" {
  name      = "reverse-game-logs"
  folder_id = var.folder_id
}

# Object Storage is intentionally managed by the bootstrap script through
# the official `yc storage bucket` API. The Terraform storage resource uses
# a separate S3/client path and can fail for user-account bootstrap tokens
# even when the same folder works for all Resource Manager APIs.

resource "yandex_mdb_postgresql_cluster_v2" "postgres" {
  name                = "reverse-game-postgres"
  description         = "Dedicated PostgreSQL for EasySong Reverse Game only"
  environment         = "PRODUCTION"
  network_id          = yandex_vpc_network.reverse_game.id
  folder_id           = var.folder_id
  deletion_protection = true
  labels              = local.labels

  config {
    version = 17

    resources {
      resource_preset_id = "s2.micro"
      disk_type_id       = "network-ssd"
      disk_size          = 16
    }
  }

  maintenance_window = {
    type = "ANYTIME"
  }

  hosts = {
    primary = {
      zone             = var.zone
      subnet_id        = yandex_vpc_subnet.reverse_game.id
      assign_public_ip = false
    }
  }
}

resource "yandex_mdb_postgresql_user" "app" {
  cluster_id = yandex_mdb_postgresql_cluster_v2.postgres.id
  name       = var.db_user
  password   = var.db_password
  conn_limit = 50
}

resource "yandex_mdb_postgresql_database" "app" {
  cluster_id          = yandex_mdb_postgresql_cluster_v2.postgres.id
  name                = var.db_name
  owner               = yandex_mdb_postgresql_user.app.name
  deletion_protection = true
}

resource "yandex_lockbox_secret" "app" {
  name                = "reverse-game-secrets"
  description         = "Runtime secrets for EasySong Reverse Game only"
  folder_id           = var.folder_id
  deletion_protection = true
  labels              = local.labels
}

resource "yandex_iam_service_account_static_access_key" "audio_storage" {
  service_account_id = yandex_iam_service_account.runtime.id
  description        = "Private temporary duel audio signing key"
}

resource "yandex_lockbox_secret_version_hashed" "app" {
  secret_id = yandex_lockbox_secret.app.id

  key_1        = "DATABASE_URL"
  text_value_1 = local.database_url

  key_2        = "SESSION_SECRET"
  text_value_2 = var.session_secret

  key_3        = "TELEGRAM_BOT_TOKEN"
  text_value_3 = var.telegram_bot_token

  key_4        = "S3_BUCKET"
  text_value_4 = var.audio_bucket_name

  key_5        = "S3_ACCESS_KEY_ID"
  text_value_5 = yandex_iam_service_account_static_access_key.audio_storage.access_key

  key_6        = "S3_SECRET_ACCESS_KEY"
  text_value_6 = yandex_iam_service_account_static_access_key.audio_storage.secret_key
}
