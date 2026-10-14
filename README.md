# QQ Daily Bot

这是一个部署在 Vercel 上的 QQ 群财经学习日报机器人。它接收 QQ 开放平台 Webhook，每天北京时间 09:00 生成一份中文财经学习日报，并发送到你绑定的 QQ 群。

没有 OpenAI API Key 时，也可以先用固定测试文案把 QQ 发送链路跑通。

## 你需要准备

- 一个 GitHub 仓库：`camillesharkk/qq-daily-bot`
- 一个 [Vercel](https://vercel.com) 账号
- 一个 [QQ 机器人](https://q.qq.com) 的 AppID 和 AppSecret
- 可选：OpenAI API Key，或一个能返回日报正文的 HTTPS 地址

ChatGPT Plus 不等于 OpenAI API 额度。Plus 是聊天产品订阅；调用本项目的 OpenAI 接口需要单独开通 API，并按用量计费。

## 本地检查

在项目目录依次执行：

```bash
npm install
npm test
npm run build
```

三项都通过后，再推送到 GitHub。

## 推送到 GitHub

```bash
git push origin main
```

不要把 `.env`、AppSecret、Access Token、OpenAI API Key 或群 OpenID 提交到 GitHub。这些内容也不要截图发给别人。

## 在 Vercel 导入项目

1. 打开 Vercel，选择 Import Git Repository。
2. 导入 `camillesharkk/qq-daily-bot`。
3. Framework 选择 Next.js。
4. 先不要填真实密钥到代码里。环境变量只加在 Vercel 项目设置中。

## 第一次部署要配置的环境变量

第一次只配置下面 5 个。`QQ_GROUP_OPENID` 先留空，等群里绑定成功后再填。

| 变量 | 说明 |
| --- | --- |
| `QQ_APP_ID` | QQ 机器人 AppID |
| `QQ_APP_SECRET` | QQ 机器人 AppSecret，只放在服务端环境变量里 |
| `QQ_API_BASE` | 开发阶段填 `https://sandbox.api.sgroup.qq.com` |
| `CRON_SECRET` | 一串足够长的随机字符串，用来保护定时任务 |
| `ADMIN_TOKEN` | 另一串随机字符串，用来保护手动测试接口 |

`QQ_API_BASE` 的默认值也是沙箱地址。正式审核上线后，再把它改成：

```text
https://api.sgroup.qq.com
```

保存环境变量后部署。部署完成会得到一个域名，Webhook 回调地址是：

```text
https://<vercel-domain>/api/qq/webhook
```

## 配置 QQ Webhook

1. 打开 QQ 开放平台，把上面的地址填进机器人的 Webhook 回调地址。
2. 接收事件选择“部分接收”，至少勾选：
   - `GROUP_AT_MESSAGE_CREATE`
   - `GROUP_ADD_ROBOT`
   - `GROUP_MSG_RECEIVE`
3. 保存后，平台会向回调地址发送验证请求。本服务会按官方 Ed25519 规则签名并返回。

签名规则见 QQ 官方文档：[安全和授权](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html)、[Webhook](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html)。

## 绑定 QQ 群

1. 把机器人拉进目标群。
2. 在群里 @机器人，发送 `绑定日报`。也可以发送包含“测试”的消息。只发送 `日报` 会读取当天已经生成的报告，不会重新生成。
3. 机器人会回复：`机器人连接成功，已识别当前群聊。`
4. 打开 Vercel 项目的 Logs，搜索：

```text
GROUP_OPENID_CAPTURED=
```

5. 等号后面的值就是这个群的 `group_openid`。把它填进 Vercel 环境变量 `QQ_GROUP_OPENID`。
6. 重新部署，让新的环境变量生效。

日志里只会打印这一条群标识，用来完成第一次绑定。不要把 AppSecret、Access Token 或其他密钥打到日志里，也不要把这行日志公开转发。

## 手动测试发送

测试接口是：

```text
POST https://<vercel-domain>/api/admin/test-send
```

请求头：

```text
Authorization: Bearer <ADMIN_TOKEN>
```

请求体可以省略。省略时发送“QQ日报机器人测试成功。”目标群只能是服务器上的 `QQ_GROUP_OPENID`，请求里不能指定别的群。

Windows PowerShell：

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "https://<vercel-domain>/api/admin/test-send" `
  -Headers @{ Authorization = "Bearer <ADMIN_TOKEN>" } `
  -ContentType "application/json" `
  -Body '{"content":"测试消息"}'
```

健康检查：

```powershell
Invoke-RestMethod -Uri "https://<vercel-domain>/api/health"
```

正常返回：

```json
{ "ok": true, "service": "qq-daily-bot" }
```

## 配置日报内容

手动测试成功后，再配置正式日报来源。优先级如下：

1. `REPORT_SOURCE_URL`：服务会 GET 这个地址。如果同时设置了 `REPORT_SOURCE_TOKEN`，会带上 `Authorization: Bearer <REPORT_SOURCE_TOKEN>`。返回 `{ "content": "..." }` 或纯文本都可以。
2. `OPENAI_API_KEY` 和 `OPENAI_MODEL`：使用 OpenAI 官方 Node.js SDK 的 Responses API，并启用当前官方的 `web_search` 工具。请到 [OpenAI web search 文档](https://developers.openai.com/api/docs/guides/tools-web-search) 选择一个支持 Responses API 和 web search、成本较低的现用模型，把模型 ID 填进 `OPENAI_MODEL`。项目不会猜测模型名。未填写 `OPENAI_MODEL`，或生成失败时，会回退到 `DAILY_MESSAGE`，不会把 OpenAI 的报错发到群里。
3. `DAILY_MESSAGE`：固定文案，适合先打通发送链路。

三个来源都没有可用内容时，定时任务返回服务器错误，不会发送空消息。

群里除固定命令外的提问走 DeepSeek，不替换上面的 OpenAI 日报。需要同时配置 `DEEPSEEK_API_KEY` 和 `DEEPSEEK_MODEL`。当前官方文档列出的模型名是 `deepseek-flash` 和 `deepseek-v4-pro`，项目不会替你选择。

定时任务按 `0 1 * * *` 运行，也就是北京时间 09:00。它会主动发到 `QQ_GROUP_OPENID`，因此需要该变量，以及 QQ 侧允许主动发群。群里只发送“日报”时，读取当天已经生成的内容，不会再调用 OpenAI。

QQ 群可能拦截未报备的网址。发送前会去掉 `http://` 和 `https://` 链接，只保留来源名称。保存的日报正文仍可带链接，供再次阅读和追问引用。

## 每天什么时候发送

`vercel.json` 里的 Cron 表达式是：

```text
0 1 * * *
```

路径是 `/api/cron/daily`。

Vercel Cron 使用 UTC。`01:00 UTC` 就是北京时间 `09:00`。中国不实行夏令时，所以这个对应关系全年不变。

Vercel 在配置了 `CRON_SECRET` 后，会给定时请求带上 `Authorization: Bearer <CRON_SECRET>`。本服务会校验这个请求头，校验失败返回 401。

也可以手动触发一次定时任务：

```powershell
Invoke-RestMethod `
  -Method Get `
  -Uri "https://<vercel-domain>/api/cron/daily" `
  -Headers @{ Authorization = "Bearer <CRON_SECRET>" }
```

成功时只返回是否成功、分段数量和日期，不返回日报全文、群 OpenID 或任何密钥。

## 环境变量一览

复制 `.env.example` 只作为本地对照。不要创建包含真实密钥的 `.env` 文件并提交。

```text
QQ_APP_ID=
QQ_APP_SECRET=
QQ_GROUP_OPENID=
QQ_API_BASE=https://sandbox.api.sgroup.qq.com
CRON_SECRET=
ADMIN_TOKEN=
OPENAI_API_KEY=
OPENAI_MODEL=
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=
DAILY_MESSAGE=
REPORT_SOURCE_URL=
REPORT_SOURCE_TOKEN=
```

`QQ_APP_SECRET` 只从服务端 `process.env` 读取。任何接口响应都不会返回环境变量或密钥。

## 安全提醒

- AppSecret、OpenAI API Key、DeepSeek API Key、Access Token、Cron Secret、Admin Token 永远不要提交到 GitHub，也不要截图发给别人。
- 开发阶段使用 `https://sandbox.api.sgroup.qq.com`。
- 机器人通过 QQ 正式审核并上线后，再把 `QQ_API_BASE` 改为 `https://api.sgroup.qq.com` 并重新部署。
- Access Token 获取地址是 `https://bots.qq.com/app/getAppAccessToken`。Token 只放在内存里，提前 60 秒视为过期，日志中不会输出 Token。
- 首页只显示服务正在运行，不显示配置、群号或密钥。
