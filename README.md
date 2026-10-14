# QQ Daily Bot

这是一个部署在 Vercel 上的 QQ 群财经学习机器人。日报原文由你在 ChatGPT 聊天里生成，再粘贴到管理页保存；机器人负责保存和转发，不在服务器上调用 OpenAI 生成日报。群里的普通提问仍走 DeepSeek。

## 你需要准备

- 一个 GitHub 仓库：`camillesharkk/qq-daily-bot`
- 一个 [Vercel](https://vercel.com) 账号
- 一个 [QQ 机器人](https://q.qq.com) 的 AppID 和 AppSecret
- 一个新建的 Neon Postgres 数据库，只给这个机器人使用

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

第一次配置下面这些变量。`QQ_GROUP_OPENID` 先留空，等群里绑定成功后再填。`DATABASE_URL` 使用新建的 Neon 数据库。

| 变量 | 说明 |
| --- | --- |
| `QQ_APP_ID` | QQ 机器人 AppID |
| `QQ_APP_SECRET` | QQ 机器人 AppSecret，只放在服务端环境变量里 |
| `QQ_API_BASE` | 开发阶段填 `https://sandbox.api.sgroup.qq.com` |
| `CRON_SECRET` | 一串足够长的随机字符串，用来保护定时任务 |
| `ADMIN_TOKEN` | 另一串随机字符串，用来保护管理页和手动测试接口 |
| `DATABASE_URL` | 新建 Neon 数据库的连接串，只放在服务端 |

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
2. 在群里 @机器人，发送 `绑定日报`。也可以发送包含“测试”的消息。只发送 `日报` 会读取当天已经保存的原文，不会重新生成。
3. 机器人会回复：`机器人连接成功，已识别当前群聊。`
4. 打开 Vercel 项目的 Logs，搜索：

```text
GROUP_OPENID_CAPTURED=
```

5. 等号后面的值就是这个群的 `group_openid`。把它填进 Vercel 环境变量 `QQ_GROUP_OPENID`。
6. 重新部署，让新的环境变量生效。

日志里只会打印这一条群标识，用来完成第一次绑定。不要把 AppSecret、Access Token 或其他密钥打到日志里，也不要把这行日志公开转发。

## 保存和发送日报

服务器上的 `/api/cron/daily` 已暂停，不会再调用 OpenAI 生成或发送日报。ChatGPT 聊天里原来的定时任务不在这个仓库中，不受这次改动影响。

1. 在 Neon 新建一个只给 `qq-daily-bot` 使用的 Postgres 项目，不要复用其他项目的生产库。
2. 把连接串填进 Vercel 的 `DATABASE_URL`。不要把它写进网址、前端代码或日志。
3. 在已配置该变量的环境执行 `npm run db:migrate`。脚本只执行 `db/migrations/001_daily_reports.sql`。
4. 打开：

```text
https://<你的域名>/admin/daily
```

5. 在页面里输入 `ADMIN_TOKEN`。密钥只放在请求头里，不要加到网址上。
6. 选择北京时间的报告日期，粘贴日报原文。先点“预览将发到 QQ 的内容”，确认去掉链接后的分段。
7. “保存”只写入数据库。群里 @机器人并发送 `日报` 会读到这份原文。
8. “保存并发送到已绑定群”会先保存，再主动发到 `QQ_GROUP_OPENID`。同一天同一群已经发送成功时不会再发。发送失败会留下正文和失败状态，可以再次发送。发送结果不明确时不会自动重发。
9. 主动发送需要 QQ 允许机器人主动发群消息。沙箱接口只能发给沙箱群；正式群需要机器人审核上线，并且 `QQ_API_BASE` 使用 `https://api.sgroup.qq.com`。如果 QQ 返回 `40034105`，正文仍然已保存，到群里 @机器人发送 `日报` 即可被动读取。

群里除固定命令外的提问走 DeepSeek。需要同时配置 `DEEPSEEK_API_KEY` 和 `DEEPSEEK_MODEL`。当前官方文档列出的模型名是 `deepseek-flash` 和 `deepseek-v4-pro`，项目不会替你选择。

QQ 群可能拦截未报备的网址。发送前会去掉 `http://` 和 `https://` 链接，只保留来源名称。数据库里的日报正文仍保留你粘贴的原文。

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

## 环境变量一览

复制 `.env.example` 只作为本地对照。不要创建包含真实密钥的 `.env` 文件并提交。

```text
QQ_APP_ID=
QQ_APP_SECRET=
QQ_GROUP_OPENID=
QQ_API_BASE=https://sandbox.api.sgroup.qq.com
CRON_SECRET=
ADMIN_TOKEN=
DATABASE_URL=
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=
```

`QQ_APP_SECRET` 只从服务端 `process.env` 读取。任何接口响应都不会返回环境变量或密钥。

## 安全提醒

- AppSecret、OpenAI API Key、DeepSeek API Key、Access Token、Cron Secret、Admin Token 永远不要提交到 GitHub，也不要截图发给别人。
- 开发阶段使用 `https://sandbox.api.sgroup.qq.com`。
- 机器人通过 QQ 正式审核并上线后，再把 `QQ_API_BASE` 改为 `https://api.sgroup.qq.com` 并重新部署。
- Access Token 获取地址是 `https://bots.qq.com/app/getAppAccessToken`。Token 只放在内存里，提前 60 秒视为过期，日志中不会输出 Token。
- 首页只显示服务正在运行，不显示配置、群号或密钥。
