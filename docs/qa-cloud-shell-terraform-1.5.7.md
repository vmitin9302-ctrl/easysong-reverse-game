# QA — Yandex Cloud Shell Terraform 1.5.7

This file exists only to trigger a pull-request CI run after aligning the Terraform configuration with the version bundled in Yandex Cloud Shell.

The terraform job must run `terraform init` and `terraform validate` using Terraform 1.5.7 before the user retries the bootstrap.
