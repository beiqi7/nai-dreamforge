# NAI 造梦工坊

[![CI](https://github.com/beiqi7/nai-dreamforge/actions/workflows/ci.yml/badge.svg)](https://github.com/beiqi7/nai-dreamforge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js 22](https://img.shields.io/badge/node-22.x-339933?logo=node.js&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

基于 NovelAI 官方 API（含 **V5**）的自托管在线生图站：多用户、PST 密钥池调度、免费层额度管控、局部重绘工作台和插件 API。

**零 npm 依赖**，只需要 Node.js 22，不用 `npm install`。

> 本项目是非官方工具，与 NovelAI / Anlatan 没有任何关联。使用时请遵守 NovelAI 的服务条款，并妥善保管自己的 API 密钥。

## 功能

- **生图**：支持 V5 / V4.5 全部模型；文生图、图生图、局部重绘（画布涂抹）；多角色提示词与站位（最多 22 个角色）
- **密钥池**：自动调度多个 PST 密钥
  - 高电量优先，同一 key 互斥排队
  - 遇到 429 先退避重试，仍失败则冷却 30 秒
  - 失效的 key 自动停用，并切换到下一个
- **用户等级**：管理员可自定义等级（分辨率、步数、张数、图生图/重绘权限、出图频率、每月 Anlas 额度），也能给单个用户单独设额度
- **画廊**：缩略图、无限滚动、收藏、批量下载 ZIP / 批量删除
- **读取参数**：从 NovelAI 生成的图片里读出元数据，回填到表单
- **提示词片段库**：画师串、动作、UC、角色、主串五类，按用户保存
- **漫画分镜工作室**（管理员）：固定角色，逐镜头生成连续画面
- **插件 API**：兼容官方 `/ai/generate-image` 协议，可接入柏宝绘（SillyTavern）
- **安全**：scrypt 密码哈希、HttpOnly 会话、CSP；登录按账号和 IP 双重限速；图片只有本人或管理员能看

## 快速开始

```bash
git clone https://github.com/beiqi7/nai-dreamforge.git
cd nai-dreamforge

# 首次启动必须设置管理员，密码至少 12 位；之后启动可以不带这两个变量
ADMIN_USER=admin ADMIN_PASS='换成你的强密码' COOKIE_SECURE=0 node server.js
```

打开 <http://127.0.0.1:7860> 登录，然后在「管理后台 → PST 密钥池」添加 NovelAI 的 PST（`pst-` 开头，在官网 Settings → API Keys 获取）。添加时会自动验证，并读取订阅等级和 Anlas 余额。

- `COOKIE_SECURE=0` 只用于本机 HTTP 调试。通过 HTTPS 访问时，保持默认值。
- 系统不会创建默认账号。首次启动缺少管理员配置时，会直接拒绝启动。

## 配置

全部通过环境变量配置：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `7860` / `127.0.0.1` | 监听地址。生产环境建议只监听本机，由反向代理对外 |
| `ADMIN_USER` / `ADMIN_PASS` | — | 只在用户表为空（首次部署）时用于创建管理员，密码 ≥ 12 位 |
| `COOKIE_SECURE` | `1` | 会话 Cookie 带 `Secure` 标记；纯 HTTP 调试时设为 `0` |
| `TRUST_PROXY_HOPS` | `1` | 本机前面有几层可信代理，用于识别登录限速用的真实 IP。只有 nginx 为 `1`，Cloudflare → nginx 为 `2`，不经代理为 `0` |
| `NAI_DB` | `data/nai.sqlite` | SQLite 数据库路径（里面存有 PST 密钥） |
| `NAI_IMG_DIR` | `data/images` | 生成图存放目录 |
| `TZ` | 系统时区 | 每月 Anlas 额度按此时区的自然月重置，如 `Asia/Shanghai` |
| `NAI_THUMB_DIR` | 图片目录旁的 `thumbs/` | 缩略图缓存目录，删掉后会按需重建 |
| `NAI_TIMEOUT_MS` | `180000` | 单次请求 NovelAI 的超时时间 |
| `PLUGIN_GEN_MAX` | `20` | 每个插件 Token 每分钟最多生图次数 |
| `SCHEDULER_QUEUE_TIMEOUT_MS` | `120000` | 所有 key 都在忙时，请求最多排队等多久 |
| `SCHEDULER_MAX_QUEUE` | `100` | 等待队列的最大长度 |
| `SCHEDULER_COOLDOWN_MS` | `30000` | key 连续 429 后的冷却时长 |
| `NAI_IMAGE_BASE` | `https://image.novelai.net` | 上游地址（测试时指向假上游） |

## 生产部署

### systemd

```ini
# /etc/systemd/system/nai-site.service
[Unit]
Description=NAI DreamForge
After=network-online.target

[Service]
WorkingDirectory=/opt/nai-site
ExecStart=/usr/bin/node server.js
# 环境变量写在 .env（已被 .gitignore 排除），例如 PORT=7860、TRUST_PROXY_HOPS=1
EnvironmentFile=/opt/nai-site/.env
Restart=on-failure
RestartSec=3
# 收到 SIGTERM 后服务会停止接收新请求，并把 WAL 写回数据库，最长 15 秒
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

`node` 的路径以 `which node` 的结果为准（用 nvm 安装时不在 `/usr/bin`）。

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name nai.example.com;
    # ssl_certificate / ssl_certificate_key ...

    client_max_body_size 25m;   # 管理员图生图、局部重绘的上传上限为 24MB

    location / {
        proxy_pass http://127.0.0.1:7860;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;    # 排队加生成可能超过 nginx 默认的 60 秒
    }
}
```

前端资源和较大的 JSON 响应已由服务自己压缩（brotli/gzip），nginx 不需要再开 gzip。

### 数据与备份

| 路径 | 内容 | 备注 |
|---|---|---|
| `data/nai.sqlite` | 用户、会话、PST 密钥、生成记录 | 敏感数据，目录权限会自动收紧为 700，备份时同样要受控 |
| `data/images/` | 生成的原图 | — |
| `data/thumbs/` | 缩略图缓存 | 可随时删除；独立于原图目录，不会被原图备份一起上传 |

`scripts/` 里附带基于 rclone 的双云备份脚本。先复制 `scripts/backup.env.example` 为 `scripts/backup.env`，再按实际环境填写：

- `backup-images.sh`：把原图复制到两个云端。配套的 `nai-backup.service` / `nai-backup.timer` 每天 04:30 运行。默认不删除本地文件，只有设置 `ALLOW_LOCAL_PRUNE=1` 才会清理两边云端都已存在、且字节数一致的本地图（比较的是大小，不是哈希）。
- `backup-images-idle.sh` + `classifier.py`：在站点空闲（最后一张图之后超过 `IDLE_MINUTES` 分钟）时，按女性角色和作品分类归档，再上传到两个云端。⚠️ **本地图总量超过 `MAX_LOCAL_MB` 时，这个脚本会直接删除最旧的本地图，而且不检查 `ALLOW_LOCAL_PRUNE`**。启用前请确认容量上限足够。
- `import-pool.js`：从文本文件批量导入 PST（每行 `email<TAB>pst-…`）。

## 用户等级与额度

管理员不受任何限制；普通用户受所在**等级**约束。等级在「管理后台 → 用户等级」里增删改，修改后立即对该等级下所有用户生效。

| 等级可配置项 | 说明 |
|---|---|
| 最大分辨率 | 单张总像素上限：1MP（1024×1024，Opus 免费上限）/ 1.5MP / 2.25MP |
| 最大步数、单次最多张数 | 超出直接拒绝 |
| 允许图生图 / 局部重绘 | 未开放时前端锁定入口，接口也会拒绝 |
| 每分钟 / 每小时 / 每天上限 | 按张数计，留空为不限 |
| 每月 Anlas 额度 | 每个自然月可消耗的 Anlas，每月 1 日 00:00 重置；0 表示只能使用 0 Anlas 的免费参数 |

首次启动会创建两个等级：

| | 普通用户（默认） | 高级用户 |
|---|---|---|
| 最大分辨率 | 1MP | 1.5MP |
| 步数 / 单次张数 | ≤ 28 / 1 张 | ≤ 40 / 4 张 |
| 图生图 / 局部重绘 | ✗ | ✓ |
| 出图频率 | 6/分 · 66/时 · 240/天 | 10/分 · 150/时 · 600/天 |
| 每月 Anlas | 0（只能免费生成） | 3000 |

「普通用户」与 Opus 免费生成的官方条件一致（单张、≤ 28 步、≤ 1048576 像素、纯文生图），升级前的老用户会自动归入这一等级。

在「管理后台 → 用户管理」里可以：
- 用下拉框直接切换某个用户的等级；
- 单独设置某个用户的**每日出图张数**和**每月 Anlas**（留空跟随等级）；
- 查看每个用户 24 小时出图张数与本月 Anlas 用量；「重置计数」只清零分钟/小时/每日张数，不影响本月 Anlas（要追加 Anlas 请调高月度额度）。

普通用户在生成按钮下方能看到自己的等级、24 小时出图张数与本月 Anlas 用量；计费生成前会显示预计消耗与本月剩余 Anlas。

「月」按服务器时区划分，请用 `TZ` 环境变量设成你所在的时区（例如 `TZ=Asia/Shanghai`），否则会按 UTC 在北京时间每月 1 日 08:00 才重置。

## 局部重绘（管理员）

基于官方 `action: "infill"` 通道实现：

- **自动换模型**：用 `nai-diffusion-5-full` 这类普通模型提交重绘时，会自动换成对应的 `-inpainting` 模型。V5 Curated 目前没有 inpainting 模型，会被拒绝，与官方一致。
- **画布工作台**：载入图片（或直接用站内生成的图）→ 用笔刷涂抹要重绘的区域 → 可撤销、清空、查看蒙版 → 调节重绘强度、选择是否保留原图色彩。
- **连续修图**：重绘结果会自动放回画布，可以接着涂抹。
- **计费**：局部重绘始终消耗 Anlas，按强度折算：`max(ceil(基础价 × 强度), 2)`。

## 插件 API（管理员）

在「管理后台 → 插件 API」生成 Token（`nai_…`）。

**柏宝绘（SillyTavern）**：渠道选 NovelAI，接口地址填站点域名，API Key 填 `nai_…`，并**关闭 Vibe Transfer**。

```bash
# JSON 接口，返回 data URL
curl -X POST https://nai.example.com/api/v1/generate \
  -H "Authorization: Bearer nai_你的token" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"1girl, solo","model":"nai-diffusion-5-full","width":832,"height":1216,"steps":28}'

# 官方协议，返回 ZIP（柏宝绘走这条）
curl -X POST https://nai.example.com/ai/generate-image \
  -H "Authorization: Bearer nai_你的token" \
  -H "Content-Type: application/json" \
  -d '{"input":"1girl, solo","model":"nai-diffusion-5-full","action":"generate","parameters":{"width":832,"height":1216,"steps":28,"scale":5,"sampler":"k_euler","n_samples":1}}' \
  -o image.zip
```

| 接口 | 说明 |
|---|---|
| `GET /api/v1/me`、`GET /api/v1/models` | 校验 Token、获取模型和采样器列表 |
| `POST /api/v1/generate` | 生图，返回 JSON（含 data URL） |
| `GET /ai/user/subscription`（也可用 `/user/subscription`） | 连通测试，返回模拟的 Opus 订阅 |
| `POST /ai/generate-image`（也可用 `/generate-image`） | 官方请求体，返回内含 PNG 的 ZIP |
| `POST /ai/encode-vibe` | 未实现，返回 404 |

没有 Token、或 Token 属于非管理员时，返回 401。

## 开发

```bash
npm run check   # 对全部 JS 文件做语法检查
npm test        # 冒烟测试：自带假 NovelAI 上游，不需要真实 key
```

测试覆盖：
- 权限策略、调度器
- 生图 → 历史 → 缩略图 → 流式批量下载的完整链路
- 失效 key 自动切换、出图频率与额度重置
- 用户等级、单人额度覆盖、多张请求计数
- 登录限速与 X-Forwarded-For 伪造、跨用户访问拦截
- 静态资源的压缩与缓存
- PNG / JPEG 编解码

每次提交 PR 或推送到 `main`，GitHub Actions 都会自动运行以上检查。

### 目录结构

```
server.js            HTTP 服务与路由（Node 22，内置 node:sqlite）
lib/nai.js           NovelAI 客户端：请求体构造 / ZIP 解包 / Anlas 计算 / inpainting 模型映射
lib/scheduler.js     密钥池调度：互斥、排队、429 退避与冷却、失效 key 切换
lib/policy.js        按角色与用户等级校验生图参数
lib/tiers.js         用户等级默认值与字段校验
lib/db.js            SQLite 表结构、迁移与查询
lib/auth.js          Cookie 会话与请求体解析
lib/nai-compat.js    官方 /ai/generate-image 请求体 → 本站请求（插件兼容）
lib/thumbs.js        缩略图 worker 线程池 + 磁盘缓存
lib/png.js           零依赖 PNG 解码 / 缩放 / 编码
lib/jpeg.js          零依赖基线 JPEG 编码（缩略图用）
lib/zip.js           ZIP 打包（插件返回、批量流式下载）
public/              前端（原生 HTML / CSS / JS）
scripts/             备份、分类归档、批量导入脚本与 systemd 配置
test/                冒烟测试
```

## NovelAI API 备忘

- **生图**：`POST https://image.novelai.net/ai/generate-image`，请求头 `Authorization: Bearer pst-…`，响应是内含 PNG 的 ZIP
- **订阅**：`GET https://image.novelai.net/user/subscription`
  - `tier`：3 表示 Opus
  - `trainingStepsLeft.fixedTrainingStepsLeft + purchasedTrainingSteps`：即 Anlas 余额
  - `usage.percent`：V5 电量
- **V5 模型**：`nai-diffusion-5-full` / `nai-diffusion-5-curated`（以及 `-inpainting`）
  - 使用 `params_version: 4`，以及 `ucPresetId`、`qualityPresetId`、`tag_hint_qt`、`tag_hint_uc_preset`、`straight_alpha`、`image_format`
  - 不再发送 `sm`、`sm_dyn`、`qualityToggle`、`skip_cfg_above_sigma`；不支持 Vibe Transfer / ControlNet
  - 支持自然语言与多语言提示词、`fur dataset,` 前缀、`transparent background` 透明背景等
- **Anlas 公式**：`ceil(2.951823174884865e-6·面积 + 5.753298233447344e-7·面积·步数)`，V5 再乘 1.5，单张最低 2
- **尺寸与调度**：尺寸必须是 64 的倍数，上限 1536；V4 及以后的模型选 `native` 噪声调度时，自动换成 `karras`

## 许可证

[MIT](LICENSE) © 2026 Serenite (beiqi7)
