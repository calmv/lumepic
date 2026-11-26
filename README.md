# LumePic

极简、顺滑、安全优先的个人自建 VPS 图床。专为单人私有图库与轻量分享设计，默认存储在 VPS 本地磁盘，配合 Docker Compose 与 Caddy 自动签发 HTTPS。

---

## 核心特性

- **极简私有后台 + 可控游客通道**
  - 单管理员极简认证（`/admin` 独立入口），首页无多余后台按钮干扰。
  - 一键开关游客上传，支持独立配置游客单图体积上限、每分钟频率限制与自动过期清理。
  - 游客无删除权限；管理员可将游客上传的图片一键转存至指定相册并生成独立永久外链（不影响游客原外链与有效期）。
- **无损隐私保护与智能 WebP 优化**
  - 支持 `JPG`、`PNG`（含 `APNG` 动图）、`WebP`（含动图）、`AVIF`、`GIF`。
  - 自动转 WebP 支持 **关闭 / 仅对游客生效 / 全部生效** 三档策略，节省 40%–70% 磁盘与带宽；动图与超长截图自动保留原格式与动画帧。
  - 默认自动剥离照片中的 GPS 定位等 EXIF 元数据；保留原格式时优先采用容器级**无损剥离**，不损伤原图画质。
  - 自动生成 `400w` WebP 缩略图与 `ThumbHash` 模糊占位，弱网滚动依然丝滑。
- **桌面端与移动端全适配体验**
  - 明暗双色毛玻璃界面，支持自定义站点标题与站点图标。
  - 全局拖拽（自动忽略页面内图片拖动）与 `Ctrl + V` 剪贴板粘贴上传，共享双并发队列与限流自动退避重试，一键复制 `Markdown` / `URL` / `HTML` / `BBCode`。
  - 相册分类与重命名、批量移动、回收站软删除与恢复、单图原名下载及多选流式 `ZIP` 打包下载。
- **随机图片 API 与第三方工具接入**
  - 可开关的随机图片接口（`/api/random` 或 `/random`），支持多选指定相册作为图源，支持横竖屏筛选与 JSON 返回。
  - 支持签发带有效期的**仅上传** `API Token`（`lp_...`），兼容 **PicGo**、**Typora**、**Obsidian** 图床插件及命令行脚本，修改管理员密码自动吊销旧 Token。
- **开箱即用的安全加固**
  - 公网首次部署强制校验一次性 `SETUP_TOKEN` 防抢注，`scrypt` 密码哈希与并发限流。
  - 管理员 `/i/` 与游客 `/g/` 随机密钥外链隔离，随时撤销或重新生成公开外链；支持 `Referer` 防盗链白名单与可选空 Referer 放行。
  - 基于 SQLite WAL 与待删队列的崩溃一致文件管理；容器默认以非 `root` 用户、只读根文件系统及最小权限运行。

---

## 技术栈

- **前端**：React 19 · TypeScript · Tailwind CSS 4 · Motion
- **后端**：Node.js 22 LTS · Hono · Built-in SQLite (`node:sqlite`) · Sharp
- **部署**：Docker Compose · Caddy 2（自动 HTTPS / HTTP3）

---

## 快速部署（VPS）

准备一台已解析域名的 Ubuntu / Debian VPS（放行 `80`、`443` 端口）：

```bash
# 1. 安装 Docker 与 Git
apt update && apt install -y curl git openssl
curl -fsSL https://get.docker.com | sh

# 2. 拉取项目并填写域名
git clone https://github.com/calmv/lumepic.git /opt/lumepic
cd /opt/lumepic
cp .env.example .env && chmod 600 .env
nano .env   # 填写 DOMAIN 和 PUBLIC_URL

# 3. 一键构建启动并查看初始化令牌
bash deploy.sh
grep '^SETUP_TOKEN=' .env
```

打开 `https://你的域名/admin` 完成管理员密码初始化即可。完整运维、备份、迁移 VPS 与换域名步骤请查看 **[部署文档 (DEPLOY.md)](./DEPLOY.md)**。

---

## 接口速查

### 1. 随机图片 API（需在后台设置中开启并勾选来源相册）

| 请求路径与参数 | 说明 |
| :--- | :--- |
| `GET /api/random` 或 `GET /random` | `302` 跳转到随机抽中的公开图片外链 |
| `?orient=landscape` / `?orient=portrait` | 仅抽取横屏（宽 > 高）或竖屏（高 > 宽）图片 |
| `?format=json` | 返回 JSON（含 `url`、`thumbUrl`、`width`、`height`） |

### 2. PicGo / 脚本上传接口

- **接口地址**：`https://你的域名/api/upload`
- **请求方式**：`POST`（`multipart/form-data`）
- **请求头**：`Authorization: Bearer 你的API_Token`
- **文件字段名**：`file`（兼容 `image`、`smfile`）
- **返回外链路径**：JSON 字段 `url`

---

## 本地开发

环境要求：Node.js `22.x`

```bash
npm ci
npm run dev      # 启动前后端开发热重载 (http://127.0.0.1:5173)
npm test         # 运行后端集成测试套件
npm run build    # 构建生产环境产物
```

---

## License

MIT
