# Mail Score｜邮件投递质量实验室

独立的 Cloudflare Workers 项目：生成一次性收件地址，接收一封测试邮件，并在不调用 mail-tester 等报告 API 的前提下生成可解释的邮件质量报告。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/y08lin4/mail-score)

> 这不是“预测 Gmail 一定进收件箱”的服务。第一版只评估收到的邮件、其可见认证证据与结构质量；不会伪装成全球信誉数据库或真实进箱率。

## 当前检测项

| 范围 | 已实现 |
| --- | --- |
| 身份认证 | DKIM 签名结构；收件链路提供的 SPF、DKIM、DMARC Authentication-Results |
| 邮件头 | From、Return-Path 对齐、Reply-To、Date、Message-ID、Subject |
| 正文 | 纯文本版本、HTML 活跃内容、远程图片数量、URL 数量、HTTP/IP/Punycode URL、附件与高风险扩展名 |
| 传输 | Received 链、MIME-Version |
| 安全 | 96 位随机收件地址、30 分钟时效、单封限制、签名报告令牌、按来源限流、1 MiB 分析上限、未知地址拒收、短期保存与定时清理 |

### 明确不做的事

- 不打开 URL、不执行附件、不加载远程图片。
- 不使用 mail-tester、黑名单聚合或“进收件箱预测”API。
- 不把原始邮件正文返回给浏览器。
- 不根据关键词给出不透明的“垃圾邮件概率”。

## 资源与数据流

```text
浏览器 POST /api/sessions
  -> D1 写入会话与收件地址哈希
  -> 返回 dl-<96-bit-random>@你的收信域

Cloudflare Email Routing
  -> Email Worker 收到邮件
  -> 验证地址、拒绝未知/过期/重复邮件
  -> 在 Email Worker 内一次性解析（不保存原始邮件）
  -> D1 保存脱敏后的结构化报告与限流计数

浏览器 GET /api/sessions?token=...
  -> 仅可读取自己会话的报告
```

## 一键部署

点击顶部 **Deploy to Cloudflare** 后，首次构建会自动创建并绑定：

- Worker、静态实验页与 Cron 清理任务
- D1 数据库（`<Worker 名称>-db`）及 `schema.sql` 表结构
- 32 字节 `TOKEN_SECRET` Secret

重复部署会复用同名资源，不会重新生成报告签名 Secret。资源均创建在此次部署选择的 Cloudflare 账号中，不会触碰现有 SMTP 测试器的资源。

### 仍需你确认的两步

Cloudflare 不允许一键部署链接静默接管域名的入站邮件，因此以下是必须由域名所有者在控制台确认的安全操作：

1. 在 Worker 的 **Settings → Variables and Secrets** 添加 `INBOUND_DOMAIN`，例如 `linyu.qzz.io`。
2. 在该域名的 **Email → Email Routing** 添加规则，将测试地址 `dl-*@linyu.qzz.io` 路由到本 Worker。若控制台仅支持 catch-all，请先确认该域没有其它需要保留的收信业务。

可选：在 Worker 的 **Settings → Domains & Routes** 绑定独立访问域，例如 `mail-score.linyu.qzz.io`。

## 命令行部署

```powershell
npm install
npm run deploy
```

`npm run deploy` 与一键部署使用相同的自引导脚本，会自动创建缺失资源并初始化数据库。无需手动填写 D1 ID 或 Secret，也不需要启用 R2、Queues 或额外的 Rate Limit 绑定。

## API（可选）

提供一个小范围、可版本化的检测 API，适合在自有后台或 CI 中创建一次性收件地址并轮询报告；它不是批量发信、邮件转发或任意 EML 上传接口。

1. `POST /api/v1/sessions`：创建一个 30 分钟有效、仅能接收一封邮件的地址。响应中返回 `address`、`token` 与 `expiresAt`。
2. 将要检测的邮件发送到 `address`。
3. `GET /api/v1/sessions?token=<token>`：轮询 `waiting`、`complete` 或 `failed` 状态；完成时返回 `report`。

```bash
curl -X POST https://你的-worker.workers.dev/api/v1/sessions
curl "https://你的-worker.workers.dev/api/v1/sessions?token=上一步的token"
```

创建和读取均按来源限流。`token` 等同于该次报告的临时访问凭证，请只在受信任的服务端保存；第三方网页浏览器跨域调用会被拒绝。

仅检查打包，不创建资源也不发布：

```powershell
npm install
npm run typecheck
npm run deploy -- --dry-run
```

## 后续阶段

1. 在不依赖报告 API 的前提下加入 DNS 查询适配器，实现 SPF 记录语法、DMARC 策略和 DKIM 公钥检查。
2. 加入完整 DKIM 密码学验签与 SPF 的受控重放验证；这需要明确收信路径能提供的原始连接证据。
3. 为用户可选地接入自建信誉数据，而不是宣称不存在的数据源。
4. 加入报告导出、历史比较和配置变更回归检测。

## 数据保留

原始邮件只在 Email Worker 内存中完成一次解析，不写入 R2 或 D1；会话过期后，定时任务会删除 D1 报告与匿名化限流计数。请仍然不要发送密码、授权码、个人证件、客户数据或真实附件。
