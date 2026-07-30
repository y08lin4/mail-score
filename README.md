# Mail Score｜邮件投递质量实验室

独立的 Cloudflare Workers 项目：生成一次性收件地址，接收一封测试邮件，并在不调用 mail-tester 等报告 API 的前提下生成可解释的邮件质量报告。

> 这不是“预测 Gmail 一定进收件箱”的服务。第一版只评估收到的邮件、其可见认证证据与结构质量；不会伪装成全球信誉数据库或真实进箱率。

## 当前检测项

| 范围 | 已实现 |
| --- | --- |
| 身份认证 | DKIM 签名结构；收件链路提供的 SPF、DKIM、DMARC Authentication-Results |
| 邮件头 | From、Return-Path 对齐、Reply-To、Date、Message-ID、Subject |
| 正文 | 纯文本版本、HTML 活跃内容、远程图片数量、URL 数量、HTTP/IP/Punycode URL、附件与高风险扩展名 |
| 传输 | Received 链、MIME-Version |
| 安全 | 96 位随机收件地址、30 分钟时效、单封限制、签名报告令牌、按来源限流、5 MiB 原始邮件上限、未知地址拒收、短期保存与定时清理 |

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
  -> R2 保存原始 RFC 822 邮件
  -> Queue 触发异步解析
  -> D1 保存脱敏后的结构化报告

浏览器 GET /api/sessions?token=...
  -> 仅可读取自己会话的报告
```

## 部署前需要你操作的内容

以下资源必须在**同一个 Cloudflare 账号**创建。不要把现有 SMTP 测试器的 Worker、R2 或 D1 直接复用给实验室。

1. 选择收信域名。建议使用 `linyu.qzz.io`，并确认它没有承载你不想受影响的现有邮箱业务。
2. 在该域名的 **Email → Email Routing** 中启用邮件路由；不要把本项目的 catch-all 转发到个人邮箱。
3. 创建 D1 数据库：`deliverability-lab`。
4. 创建 R2 Bucket：`deliverability-lab-raw-mail`。
5. 创建 Queue：`deliverability-lab-analyze`。
6. 用 `schema.sql` 初始化 D1。
7. 把 D1 的 `database_id` 以及实际收信域名填入 `wrangler.jsonc`。
8. 设置 `TOKEN_SECRET` 为至少 32 个随机字节的 Secret；它不能放进 `wrangler.jsonc` 或 Git。
9. 部署本 Worker 后，在 Email Routing 中添加路由规则：把 `dl-*@你的域名`（若控制台不支持通配本地部分，则使用 catch-all）投递到此 Worker。
10. 在 Worker 的 Settings 中设置一个仅用于实验室的 HTTP 自定义域名，例如 `deliverability-lab.linyu.qzz.io`。

## 推荐命令

```powershell
cd deliverability-lab
npm install
npx wrangler d1 create deliverability-lab
npx wrangler r2 bucket create deliverability-lab-raw-mail
npx wrangler queues create deliverability-lab-analyze
npx wrangler d1 execute deliverability-lab --remote --file=./schema.sql
npx wrangler secret put TOKEN_SECRET
npm run typecheck
npm run deploy
```

部署前，先将 Wrangler 输出的 D1 ID 写入 `wrangler.jsonc`，并将：

```json
"INBOUND_DOMAIN": "REPLACE_WITH_YOUR_EMAIL_ROUTING_DOMAIN"
```

改成实际用于收信的域名，例如 `linyu.qzz.io`。

## 后续阶段

1. 在不依赖报告 API 的前提下加入 DNS 查询适配器，实现 SPF 记录语法、DMARC 策略和 DKIM 公钥检查。
2. 加入完整 DKIM 密码学验签与 SPF 的受控重放验证；这需要明确收信路径能提供的原始连接证据。
3. 为用户可选地接入自建信誉数据，而不是宣称不存在的数据源。
4. 加入报告导出、历史比较和配置变更回归检测。

## 数据保留

会话过期后，定时任务会删除对应 R2 原始邮件和 D1 报告。请仍然假定测试邮件可能包含敏感内容：不要发送密码、授权码、个人证件、客户数据或真实附件。
