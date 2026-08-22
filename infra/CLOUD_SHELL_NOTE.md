# Cloud Shell bootstrap note

The bootstrap intentionally downloads the repository as a GitHub archive into `/tmp` instead of using `git clone` in `$HOME`.

Yandex Cloud Shell's persistent home filesystem can reject chmod/filemode changes inside `.git` metadata (`core.filemode` / `.git/config.lock`). The archive path avoids that Git-specific filesystem requirement while keeping Terraform state and bootstrap secrets in `$HOME/.reverse-game-bootstrap`, outside the repository and outside Git.
