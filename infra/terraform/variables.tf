variable "cloud_id" {
  description = "Yandex Cloud ID that contains the dedicated reverse-game folder."
  type        = string
}

variable "folder_id" {
  description = "Dedicated Yandex Cloud folder ID for this project only."
  type        = string
}

variable "zone" {
  description = "Primary availability zone."
  type        = string
  default     = "ru-central1-d"
}

variable "subnet_cidr" {
  description = "Private subnet for Serverless Containers and Managed PostgreSQL."
  type        = string
  default     = "10.71.0.0/24"
}

variable "web_bucket_name" {
  description = "Globally unique Object Storage bucket name for the built web app."
  type        = string
}

variable "github_owner" {
  description = "GitHub owner used in the OIDC subject and audience."
  type        = string
  default     = "vmitin9302-ctrl"
}

variable "github_repository" {
  description = "GitHub repository name used in the OIDC subject."
  type        = string
  default     = "easysong-reverse-game"
}

variable "db_name" {
  description = "Application PostgreSQL database name."
  type        = string
  default     = "reverse_game"
}

variable "db_user" {
  description = "Application PostgreSQL username."
  type        = string
  default     = "reverse_game"
}

variable "db_password" {
  description = "Strong PostgreSQL password. Keep it outside Git; Terraform stores only the configured resource state in your chosen state backend."
  type        = string
  sensitive   = true
}

variable "session_secret" {
  description = "High-entropy HMAC/session secret for privacy-preserving identifiers."
  type        = string
  sensitive   = true
}

variable "telegram_bot_token" {
  description = "Token of the new standalone reverse-game Telegram bot."
  type        = string
  sensitive   = true
}

variable "telegram_webhook_secret" {
  description = "High-entropy Telegram webhook secret token."
  type        = string
  sensitive   = true
}
