output "github_actions_service_account_id" {
  description = "Set GitHub Actions variable YC_SA_ID to this value."
  value       = yandex_iam_service_account.deploy.id
}

output "runtime_service_account_id" {
  description = "Set GitHub Actions variable YC_RUNTIME_SA_ID to this value."
  value       = yandex_iam_service_account.runtime.id
}

output "folder_id" {
  description = "Set GitHub Actions variable YC_FOLDER_ID to this value."
  value       = var.folder_id
}

output "registry_id" {
  description = "Set GitHub Actions variable YC_REGISTRY_ID to this value."
  value       = yandex_container_registry.reverse_game.id
}

output "network_id" {
  description = "Set GitHub Actions variable YC_NETWORK_ID to this value."
  value       = yandex_vpc_network.reverse_game.id
}

output "lockbox_secret_id" {
  description = "Set GitHub Actions variable YC_LOCKBOX_SECRET_ID to this value."
  value       = yandex_lockbox_secret.app.id
}

output "log_group_id" {
  description = "Set GitHub Actions variable YC_LOG_GROUP_ID to this value."
  value       = yandex_logging_group.reverse_game.id
}

output "web_bucket" {
  description = "Set GitHub Actions variable YC_WEB_BUCKET to this value. Bucket is created by the Cloud Shell bootstrap through yc CLI."
  value       = var.web_bucket_name
}

output "web_website_endpoint" {
  description = "Object Storage website endpoint before the custom domain/CDN is attached."
  value       = "https://${var.web_bucket_name}.website.yandexcloud.net"
}

output "postgres_fqdn" {
  description = "Private PostgreSQL hostname; accessible from the project VPC only."
  value       = yandex_mdb_postgresql_cluster_v2.postgres.hosts["primary"].fqdn
}

output "workload_identity_federation_id" {
  description = "GitHub OIDC workload identity federation ID."
  value       = yandex_iam_workload_identity_oidc_federation.github.id
}
