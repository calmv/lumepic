#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
umask 077

if ! docker compose version >/dev/null 2>&1; then
  echo "请先从 Docker 官方软件源安装 Docker Engine 和 Compose 插件。" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  install -m 0600 .env.example .env
fi
chmod 0600 .env

read_env_value() {
  awk -v name="$1" '
    {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      if (index(line, "#") == 1) next
      if (index(line, name "=") == 1) {
        val = substr(line, length(name) + 2)
        sub(/^[[:space:]]+/, "", val)
        sub(/[[:space:]]+$/, "", val)
        if ((val ~ /^".*"$/) || (val ~ /^\x27.*\x27$/)) {
          val = substr(val, 2, length(val) - 2)
        }
        value = val
      }
    }
    END { print value }
  ' .env
}

domain="${DOMAIN:-$(read_env_value DOMAIN)}"
if [[ ! "$domain" =~ ^([[:alnum:]]([[:alnum:]-]*[[:alnum:]])?\.)+[[:alpha:]]([[:alnum:]-]*[[:alnum:]])?$ ]]; then
  echo "请在 .env 的 DOMAIN 中填写已解析到此 VPS 的域名，例如 img.example.com。" >&2
  exit 1
fi

if [[ -z "${SETUP_TOKEN:-$(read_env_value SETUP_TOKEN)}" && -z "${ADMIN_PASSWORD:-$(read_env_value ADMIN_PASSWORD)}" ]]; then
  token=$(openssl rand -hex 32)
  printf '\nSETUP_TOKEN=%s\n' "$token" >> .env
fi

uid="${APP_UID:-$(read_env_value APP_UID)}"
gid="${APP_GID:-$(read_env_value APP_GID)}"
uid="${uid:-1000}"
gid="${gid:-1000}"
if [[ ! "$uid" =~ ^[0-9]+$ || "$uid" -eq 0 || ! "$gid" =~ ^[0-9]+$ || "$gid" -eq 0 ]]; then
  echo "APP_UID 和 APP_GID 必须是非 0 的数字。" >&2
  exit 1
fi
if [[ ! -d ./data ]]; then
  if [[ "$(id -u)" -eq 0 ]]; then
    install -d -m 0750 -o "$uid" -g "$gid" ./data
  elif [[ "$(id -u)" -eq "$uid" && "$(id -g)" -eq "$gid" ]]; then
    install -d -m 0750 ./data
  else
    echo "请把 APP_UID/APP_GID 设置为当前账户，或由管理员预先创建可写的 ./data。" >&2
    exit 1
  fi
fi

docker compose config --quiet
docker compose build --pull app
docker compose up -d --wait --wait-timeout 180
curl --fail --silent --show-error --retry 10 --retry-delay 3 --retry-all-errors --max-time 8 "https://${domain}/api/health" >/dev/null
echo "部署已通过 HTTPS 健康检查。访问 https://${domain}/admin 完成初始化或登录。"
