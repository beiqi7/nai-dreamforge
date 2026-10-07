# NAI 造梦工坊 — NovelAI 在线生图站

基于 NovelAI 最新 API（含 **V5 模型**）的在线生图网站。PST 密钥池调用，支持 Anlas 额度查询，管理员/普通用户双角色。

## 快速启动

```bash
# 首次启动必须显式设置管理员；密码至少 12 位
ADMIN_USER=admin ADMIN_PASS='请替换为高强度密码' node server.js
# 由 HTTPS 反向代理访问时保持 COOKIE_SECURE=1（默认）；仅本机纯 HTTP 调试可临时设为 0
```

打开 `http://localhost:7860`。系统不会创建或展示默认弱口令；首次启动缺少安全管理员配置时会拒绝启动。

管理员登录后在「管理面板 → PST 密钥池」录入 NovelAI 的 PST（`pst-` 开头，官网 Settings → API Keys 获取），录入时自动验证并读取订阅层级与 Anlas 余额。

## 角色 capability

| 功能 | 管理员 | 普通用户 |
|---|---|---|
| 模型 | 全部（V5/V4.5/V4/V3 + inpainting 权重） | 全部 t2i 模型 |
| 尺寸 | ≤1536（任意） | **≤1024×1024 总像素** |
| 步数 | ≤50 | **≤28** |
| 张数 | 1–8（第 2 张起计 Anlas） | **仅 1 张** |
| 图生图 i2i | ✓ | ✗（无权限，双层拦截） |
| 局部重绘 infill | ✓（画布工作台） | ✗（无权限，双层拦截） |
| 角色参考 | ✓ | ✓（Opus 免费规格内可用） |
| Anlas 消耗 | 默认免费层起步，越界部分计费 | **锁死 Opus 免费层（0 Anlas）** |
| 密钥池管理 / 用户管理 / 全站记录 | ✓ | ✗ |

**管理员语义**：默认与普通用户一样从 Opus 免费层参数起步（832×1216、28 步、单张 = 0 Anlas），
只是不设上限——拉大尺寸、加步数、多张、img2img、inpaint 时越界部分按官方公式计费。
前端有实时徽章提示当前处于「🆓 免费层」还是「💰 计费生成」。

普通用户的约束对齐 NovelAI Opus 免费生成的官方条件：`n_samples=1`、`steps≤28`、`width*height≤1048576`、纯文生图。

**免费用户 i2i / infill 封禁为双层纵深防御**：policy 入口即拒（400）+ server 级二次断言（403），前端对免费用户彻底隐藏工作台入口。

## 局部重绘（Inpaint）— 管理员专属

基于官方 `action: "infill"` 通道实现：

- **模型自动切换**：选 `nai-diffusion-5-full` 等普通模型提交重绘时，自动切换到对应的 `-inpainting` 权重（V5 Curated 暂无 inpainting 权重，会被拒绝——与官方一致）
- **画布工作台**：载入图片或直接引用站内生成图 → 笔刷涂抹（白=重绘、黑=保留，红色半透明预览）→ 撤销/清空/蒙版查看 → 强度滑杆（`inpaintImg2ImgStrength`）→ 保留原图色彩开关（`add_original_image`）
- **计费**：inpaint 恒耗 Anlas（官方规则），按强度计：`per = max(ceil(base × strength), 2)`
- **连续修图**：重绘结果自动回填画布，可继续涂抹
- payload 细节：`action: "infill"`、`parameters.image/mask/add_original_image/inpaintImg2ImgStrength/img2img{strength,color_correct:false}`，V5 同样 `params_version: 4`

## 架构

```
server.js            零依赖 HTTP 服务（Node 22，node:sqlite）
lib/nai.js           NovelAI 客户端：payload（generate/img2img/infill）/ ZIP 解包 / Anlas 计算 / inpainting 模型映射
lib/db.js            SQLite：users / nai_keys / generations / sessions
lib/policy.js        角色权限策略（管理员默认免费层可越界；普通用户硬锁免费层）
lib/auth.js          Cookie 会话鉴权
lib/scheduler.js     Key 互斥、等待队列、429 退避与租约释放
public/              前端（原生 HTML/CSS/JS，暗夜主题 + inpaint 画布工作台）
scripts/             双云备份、空闲分类备份与 systemd 配置
test/security-smoke.js 安全回归冒烟测试
```

## NovelAI API 要点（本研究确证）

- 生图 `POST https://image.novelai.net/ai/generate-image`，`Authorization: Bearer pst-xxx`，响应为 **ZIP 内含 PNG**
- 订阅 `GET https://image.novelai.net/user/subscription` → tier(3=Opus) / `trainingStepsLeft.{fixedTrainingStepsLeft,purchasedTrainingSteps}`（即 Anlas）/ `perks.unlimitedImageGenerationLimits`
- **V5 模型**：`nai-diffusion-5-full` / `nai-diffusion-5-curated`（+ `-inpainting`）
  - `params_version: 4`、`ucPresetId`、`qualityPresetId`、`tag_hint_qt`、`tag_hint_uc_preset`、`straight_alpha`、`image_format`
  - 剔除 `sm/sm_dyn/qualityToggle/skip_cfg_above_sigma`；不支持 Vibe Transfer / ControlNet
  - 支持自然语言与多语言提示词、`fur dataset,` 前缀（furry 模式）、`transparent background` 透明、`depthness`/`low|medium|high|ultra complexity` 等新标签
- Anlas 公式：`ceil(2.951823174884865e-6·area + 5.753298233447344e-7·area·steps)`，单张下限 2；Opus 免费条件见上表
- 尺寸须为 64 的倍数，上限 1536；`native` 噪声调度对 V4+ 自动换 `karras`


## 插件 API（仅管理员）

管理面板「插件 API」生成 Token。

**柏宝绘（SillyTavern）**：渠道选 NovelAI，接口地址填站点 origin，API Key 填 `nai_…`，**关闭 Vibe**。

```bash
# JSON
curl -X POST http://127.0.0.1:7860/api/v1/generate \
  -H "Authorization: Bearer nai_你的token" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"1girl, solo","model":"nai-diffusion-5-full","width":832,"height":1216,"steps":28}'

# 官方协议（ZIP），柏宝绘走这条
curl -X POST http://127.0.0.1:7860/ai/generate-image \
  -H "Authorization: Bearer nai_你的token" \
  -H "Content-Type: application/json" \
  -d '{"input":"1girl, solo","model":"nai-diffusion-5-full","action":"generate","parameters":{"width":832,"height":1216,"steps":28,"scale":5,"sampler":"k_euler","n_samples":1}}' \
  -o image.zip
```

- `GET /api/v1/me`、`GET /api/v1/models`、`POST /api/v1/generate`（JSON data URL）
- `GET /ai/user/subscription` 连通测试（假 Opus）
- `POST /ai/generate-image` 官方体，ZIP 内 PNG
- `POST /ai/encode-vibe` 未实现（404）
- 无 Token / 非管理员 401

## 测试

```bash
npm run check
npm test
```

安全测试覆盖：
- **策略层**：免费用户 img2img/inpaint/nSamples/steps/尺寸拦截、无效模型、空提示词、超长提示词、尺寸边界、管理员权限与 keyFanout 免费层约束
- **调度器**：异常时租约释放（锁不泄漏）、无候选密钥 NO_CANDIDATE 错误
- **HTTP 安全**：安全响应头（CSP/nosniff/DENY）、登录失败限速（账户+IP 双维度）、管理员自降权/自禁用/自删拦截、最后管理员保护、普通用户不可查询密钥余额（403）、普通用户不可访问管理端点（403）、未认证访问拦截（401）、无效 JSON/超大请求体拒绝（400/413）、用户资料修改（原密码校验/短密码/重名）、提示词库 CRUD 跨用户鉴权（403）、图片属主校验与路径穿越防护

真实 NovelAI 上游、双云 `rclone` 和生产 systemd 环境仍需在部署机验证。

## 存储与备份安全

- `data/`、SQLite/WAL 和图片目录在启动时会收紧权限；PST 仍是数据库内的敏感数据，生产备份必须受控。
- 删除生成记录或用户时会同步清理关联本地图片，避免持续产生不可访问的孤儿文件。
- `backup-images-idle.sh` 只负责分类和双云复制，不再自动删除本地图；超过容量阈值时仅告警。
- `backup-images.sh` 默认也不清理本地文件。只有明确设置 `ALLOW_LOCAL_PRUNE=1` 才启用旧的“双云存在且字节数相同”清理流程；该流程不是哈希校验，开启前必须确认备份与保留策略。
- 现有 `data/backup.log` 显示最近一次记录停在 CLOUD1 复制开始处，部署机上需用 `journalctl -u nai-backup` 核查真实任务状态。
