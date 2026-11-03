# 报价批量导入：上传超时与切页丢结果修复（2026-11-03）

## 一、三个问题与根因

### 问题 1：上传后显示「服务器超时」

**症状**：选一份台账（xlsx/csv）点上传，转一圈后报「服务器超时」。真实的文件其实只有十几 MB。

**根因是三层叠加，不是单一 bug**：

1. **传输用了 JSON + base64**。旧实现把整个文件读进内存转 base64，塞进 `{ fileName, data }` 用
   `fetch` POST。base64 有固定 4/3 膨胀：12.25MB 的台账变成 17MB 的请求体。
2. **客户端超时写死在 90 秒**，而 17MB 走公网（桌面端服务地址指向隧道域名）根本传不完：
   客户端到点先报「服务器超时」，服务端那一头的 413（大小超限）还没机会回话。
3. **服务端单条路由的 `bodyLimit` 只有 12MB**。就算传过去了，也被 413 顶回来，而前端把
   413 的英文 `Payload Too Large` 又裹进一句「服务器超时」。

**结论**：界面上的「服务器超时」与真实原因（文件太大 + base64 膨胀 + 公网传输）毫无关系，
属于典型的「错误文案掩盖了真实故障」。

### 问题 2：切到别的项目后上传失败、切回无显示

**根因**：识别结果（`preview`、`rows`、草稿表）都挂在 `QuoteImportPanel` 的组件 `useState`
上。切到别的页面时组件卸载，这些 state 跟着走；而上传请求还在飞，结果回来没人接 ——
界面一片空白。请求本身也被「发了一半没人管」，看起来像上传失败。

## 二、修复方案

### 传输：base64 JSON → 原始字节 + XHR

- 上传改用 **`XMLHttpRequest` + `application/octet-stream`**，直接送文件原始字节，去掉 40% 的
  base64 膨胀；
- 文件名放到请求头 `x-quote-file-name`（URL 编码），服务端靠它选识别器；
- 服务端 `import/preview` 改为读 `request.body`（Buffer），按解码后字节数校验大小；旧的
  JSON 请求体（`{ fileName, data }`）拿到的是空 Buffer，明确回 `empty_file` 而不是糊弄过去。

### 进度：两阶段分别给真实进度

- **上传阶段**：XHR 的 `upload.onprogress` 给的是**真实**的已传字节数，据此画百分比进度条；
- **识别阶段**：服务端一次请求一个结果，中间没有刻度，所以**只显示「服务器识别中 · 已 N 秒」**，
  不编百分比（给不出来的数字就是假进度）；
- 写入阶段（确认导入）同理只显示已用秒数，且**不可取消**（那一步已经在改库）。

### 切页不丢：任务状态提升到模块级

- 识别/草稿/上传进度全部挪进 `lib/quote-import-task.ts` 的**模块级 state**，用
  `useSyncExternalStore` 订阅。组件卸载不丢状态，切回来自动续上进度与结果；
- 组件卸载会触发 `cancelImportUpload`（AbortController），把没人接的请求断掉，避免「发了一半」。

### 超时与大小：三处一致

| 位置 | 值 | 作用 |
| --- | --- | --- |
| `QUOTE_LIMITS.IMPORT_FILE_BYTES_MAX` | 20MB | 前端前置校验 + 服务端解码后校验 |
| nginx `client_max_body_size` | 24m | 第三道兜底，比服务端留 4MB 余量 |
| nginx `proxy_read_timeout` / `proxy_send_timeout` | 300s | 大文件走公网够用 |

**前置校验是最重要的一道**：超限文件现在**一个字节都不发**，前端直接给出中文提示
「超过 20 MB，先压缩一下再选」，不再等传完 17MB 才被服务端拒。

## 三、涉及文件

| 文件 | 改动 |
| --- | --- |
| `packages/shared/src/quote.ts` | `IMPORT_FILE_BYTES_MAX` 8MB → 20MB；删掉不再用的 `QuoteImportPreviewRequest` |
| `apps/api/src/routes/quote.ts` | `import/preview` 从 JSON 改收原始字节 + `x-quote-file-name`；删 `IMPORT_PREVIEW_BODY_SCHEMA` |
| `apps/web/src/lib/quote-import-upload.ts` | 新增：XHR 上传 + `onprogress` + AbortController |
| `apps/web/src/lib/quote-import-task.ts` | 新增：模块级任务状态机（idle/uploading/analyzing/confirming/applying） |
| `apps/web/src/lib/quote-import-display.ts` | 新增：`validateImportFile`、`uploadPercent`、`importProgressLabel` 等纯函数 |
| `apps/web/src/lib/api.ts` | 删旧 base64 预览请求；导出 `apiEndpoint` / `toApiError` 给 XHR 复用 |
| `apps/web/src/lib/quote.ts` | 删 `previewQuoteImport` / `fileToBase64` |
| `apps/web/src/components/quote/maint/QuoteImportPanel.tsx` | 重写：进度条（两阶段）、切页续接、前置校验 |
| `apps/web/deploy/nginx.conf` | `client_max_body_size` 20m → 24m；`proxy_read/send_timeout` 60s → 300s |
| `apps/web/test/quote-import-display.test.mjs` | 新增：进度/文案纯函数 |
| `apps/web/test/quote-import-limits.test.mjs` | 新增：前后端上限一致性（跨层钉住） |
| `apps/web/test/quote-maint-workbench.test.mjs` | 更新接线断言 |
| `apps/api/test/quote.test.ts` | 补一条：octet-stream 收原始字节、文件名走头、JSON 被明确拒绝 |

## 四、验证

- **门禁全绿**：test / lint / typecheck / format:check 均 0 失败。
- **反例注入**：把关键点一个个改坏（改回 base64、去掉前置校验、把状态挪回 useState、
  识别阶段编百分比、nginx 超时改回 60s、服务端不校验大小等），断言均如期变红后还原。
- **产物核对**：
  - `POST /api/quote/import/preview` 带 `application/octet-stream` + `x-quote-file-name` 返回 401
    （路由存在、接受新契约），不存在的路径对照 404；
  - nginx 容器内 `client_max_body_size 24m`、`proxy_read_timeout 300s`、`proxy_send_timeout 300s`；
  - 前端 bundle 含「正在上传 / 服务器识别中 / 正在写入数据库」、`onprogress`、
    `application/octet-stream`、`x-quote-file-name`；旧的 `quoteImportPreviewRequest` / `fileToBase64`
    已彻底移除。

## 五、给用户的验证步骤

1. 选一份十几 MB 的台账上传，观察进度条：先走百分比（上传），再走「识别中 · 已 N 秒」；
2. 上传途中切到别的项目再切回，确认进度与结果还在；
3. 选一份超过 20MB 的文件，确认**立刻**弹中文提示（不等上传、不发请求）；
4. 正常小文件走完整链路：识别 → 改草稿 → 确认导入，确认写库结果正确。
