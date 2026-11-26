# LumePic 部署文档

## 一、 全新 VPS 部署（Ubuntu / Debian）

### 1. 解析域名与放行端口

- 将域名 `A` 记录解析到 VPS 公网 IP（有 IPv6 可同时添加 `AAAA` 记录）。
- 防火墙/安全组放行 `80/TCP`、`443/TCP`、`443/UDP`。

### 2. 安装 Docker 与 Git

```bash
apt update && apt install -y curl git openssl
curl -fsSL https://get.docker.com | sh
```

### 3. 拉取项目并配置 `.env`

**方式 A：从 GitHub 拉取（推荐，最省事）**

```bash
git clone https://github.com/calmv/lumepic.git /opt/lumepic
```

**方式 B：手动 SFTP 上传**

在 VPS 创建 `/opt/lumepic` 目录，按以下清单上传本地文件（SFTP 工具请开启“显示隐藏文件”，勿漏传 `.env.example` 和 `.dockerignore`）：
- **必须上传的文件夹**：`src/`、`public/`
- **必须上传的文件**：`Dockerfile`、`docker-compose.yml`、`Caddyfile`、`deploy.sh`、`.env.example`、`.dockerignore`、`package.json`、`package-lock.json`、`index.html`、`vite.config.ts`、`tsconfig.json`、`tsconfig.server.json`
- **不要上传**：`node_modules/`、`dist/`、`data/`、本地 `.env`

代码就绪后，创建并填写 `.env` 配置文件：

```bash
cd /opt/lumepic
cp .env.example .env
chmod 600 .env
nano .env
```

将 `.env` 中的域名改为你的实际域名（`Ctrl + O` 回车保存，`Ctrl + X` 退出）：

```dotenv
DOMAIN=img.example.com
PUBLIC_URL=https://img.example.com
```

### 4. 一键启动与初始化

```bash
cd /opt/lumepic
bash deploy.sh
grep '^SETUP_TOKEN=' .env
```

1. 打开 `https://你的域名/admin`，输入终端显示的 `SETUP_TOKEN` 并设置管理员密码。
2. 登录成功后，清理一次性初始化令牌：

```bash
sed -i '/^SETUP_TOKEN=/d' /opt/lumepic/.env
cd /opt/lumepic && docker compose up -d
```

---

## 二、 常用运维命令

```bash
# 查看运行状态
cd /opt/lumepic && docker compose ps

# 查看实时日志（Ctrl + C 退出）
cd /opt/lumepic && docker compose logs -f --tail=100

# 修改 .env 后重新生效
cd /opt/lumepic && docker compose up -d

# 拉取 GitHub 最新代码并重新构建上线（保留 .env 和 data 数据）
cd /opt/lumepic && git pull && bash deploy.sh
```

---

## 三、 备份与迁移 VPS

所有图片、数据库、相册、Token 和站点图标均保存在 `./data` 目录。

### 备份数据

```bash
cd /opt/lumepic
docker compose stop app
tar -czf /root/lumepic-backup-$(date +%F).tar.gz data .env
docker compose start app
```

### 迁移到新 VPS

1. 在新 VPS 安装 Docker，并将项目代码放到 `/opt/lumepic`。
2. 将备份包传到新 VPS 的 `/opt/lumepic` 目录并解压：

```bash
cd /opt/lumepic
tar -xzf lumepic-backup-xxxx-xx-xx.tar.gz
chmod 600 .env
chown -R 1000:1000 ./data
```

3. 将域名解析改到新 VPS IP，启动服务：

```bash
cd /opt/lumepic
bash deploy.sh
```

---

## 四、 修改域名

将新域名解析到当前 VPS 后，修改 `/opt/lumepic/.env` 中的 `DOMAIN` 和 `PUBLIC_URL`，重新执行部署脚本即可（历史图片外链会自动跟随新域名）：

```bash
cd /opt/lumepic
nano .env
bash deploy.sh
```

若旧域名仍保留，可在 `Caddyfile` 末尾追加以下规则让旧外链自动 301 跳转到新域名（修改后执行 `docker compose restart caddy`）：

```caddyfile
https://旧域名 {
	redir https://{$DOMAIN}{uri} permanent
}
```
