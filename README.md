# Cloudflare Speed Test

两个按钮：**测速 → 写入**。浏览器从当前网络测量固定 HTTPS 候选入口，Worker 将优选 IPv4 / IPv6 写入指定的 Cloudflare DNS 记录。没有数据库、定时任务或历史统计。

| 项目 | 配置 |
| --- | --- |
| GitHub | `ThaneJoss/cloudflare-speed-test` |
| 页面 / Worker Custom Domain | `cf-speed-test.thanejoss.com` |
| DNS 写入目标 | `cf-best-ip.thanejoss.com` |
| 记录类型 | A / AAAA |
| 代理与 TTL | DNS only（灰云），300 秒 |

## 部署前必须准备的内容

**代码可以构建，但仓库没有预设真实测速入口。`probes.json` 有意保持为空；部署后必须完成下面的入口配置，才能测速。**

普通浏览器无法实现 `curl --resolve`，也不能任意覆盖 TLS SNI 或 HTTP Host。因此本项目采用你选择的「固定 HTTPS 候选入口」方案，**不能扫描任意 Cloudflare IP**。需要你已有的、可验证的「HTTPS 域名 ↔ 单个 Cloudflare IP」映射；一个普通 Worker Custom Domain，或给它新增一个灰云 A 记录，并不会自动提供这样的入口。

如果尚无这些入口，先准备入口基础设施。不能把 `https://104.16.x.x` 的证书错误或 `fetch(..., {mode: 'no-cors'})` 的完成时间当作成功测速。仓库提供响应处理示例，但不自动创建证书、Cloudflare for SaaS 自定义主机或改变现有 Worker 路由。

### 1. 配置真实 HTTPS 候选入口

编辑根目录的 `probes.json`，最多 12 个。以下仅演示格式，域名不可直接使用，IP 也没有为你的网络实测过：

```json
[
  {
    "id": "edge-v4-a",
    "name": "IPv4 入口 A",
    "ip": "104.16.0.1",
    "url": "https://edge-v4-a.example.net/__cfst"
  },
  {
    "id": "edge-v6-a",
    "name": "IPv6 入口 A",
    "ip": "2606:4700::1",
    "url": "https://edge-v6-a.example.net/__cfst"
  }
]
```

每个候选需要独立域名、可信 TLS 证书、正常 HTTPS 响应，并满足：

- 域名只解析到配置中的那个 IP；不能同时存在另一地址族或多个地址。IPv4 / IPv6 分开使用域名。
- 不包含 CNAME、DNAME 或 HTTPS/SVCB 替代地址；禁用替代主机路由和 HTTP/3 `Alt-Svc` 广告，或者返回 `Alt-Svc: clear`。
- 该 IP 必须属于运行时从 Cloudflare 官方 `/client/v4/ips` API 获取的网段。
- GET 请求支持 `bytes=1024`、`bytes=262144` 和随机 `nonce` 参数，返回精确大小的不可压缩二进制数据、HTTP 200，不重定向。
- 返回 `X-CFST-ID`（候选 ID）和 `X-CFST-Nonce`（原样返回 nonce）；允许本页面的 CORS 请求并暴露校验头；设置 `Cache-Control: no-store, no-transform`。

响应实现见 [`examples/probe-handler.mjs`](examples/probe-handler.mjs)。它可以集成到已经具备正确 DNS、TLS 和路由的入口；它本身不能解决固定 IP 路由。

```bash
npm ci
npm run verify:probes
```

这一步检查公共 DNS、TLS、CORS 和响应协议，不输出「你的网络最快 IP」排名。实际性能测试始终发生在点击按钮的浏览器中。客户端的 VPN、代理、DNS 改写或 DNS64 可能改变实际路径；浏览器无法读取实际远端 TCP 地址，公共 DNS 检查不能提供逐连接 IP 的密码学证明。请在期望优化的实际网络路径下操作。

### 2. 设置 Cloudflare Access

为 `cf-speed-test.thanejoss.com` 创建 Self-hosted Access Application，Allow 策略只允许你的管理员账号。不要使用 Bypass / Everyone 策略。

在 `wrangler.jsonc` 中填入：

```json
"ACCESS_TEAM_DOMAIN": "your-team.cloudflareaccess.com",
"ACCESS_AUD": "your-access-application-audience"
```

`APP_ORIGIN` 和 `CF_ZONE_ID` 已按此项目配置。Worker 会独立验证 Access JWT 的签名、issuer、audience 和有效期。缺少配置时 API 拒绝操作；前端没有额外的登录按钮。

### 3. 设置 Worker Secrets

创建一个仅对 `thanejoss.com` 拥有 **Zone / DNS / Edit** 权限的 API Token。这个 token 用于运行时修改 DNS，不能提交到 GitHub，也不能放到浏览器中。

```bash
npx wrangler login
npx wrangler secret put CF_DNS_API_TOKEN
npx wrangler secret put RUN_SIGNING_SECRET
```

按提示输入值。`RUN_SIGNING_SECRET` 使用密码管理器生成的至少 32 字符随机值。Wrangler 如果提示 Worker 不存在，可以先执行一次 `npm run deploy` 创建 Worker（缺少 Secrets 时写入接口保持关闭），再设置 Secrets。

### 4. 部署

需要 Node.js 24 或更新版本。部署账户必须有此 Zone 和 Workers 的管理权限。

```bash
npm run check
npm test
npm run build
npm run deploy
```

或者在 Cloudflare Workers & Pages 中连接此 GitHub 仓库，选择 **Worker 项目**，构建命令 `npm run check && npm test`，部署命令 `npx wrangler deploy`；在对应 Worker 中配置上面的两个 Secrets。固定入口仍须先通过 `npm run verify:probes`。这是 Worker + Static Assets 项目，不是仅上传 `public/` 的静态 Pages 站点。

`wrangler.jsonc` 会绑定 `cf-speed-test.thanejoss.com`。目标 `cf-best-ip.thanejoss.com` 由写入按钮管理，不应绑定为本项目的 Custom Domain。

## 按钮行为

**测速**：服务端先校验每个候选的公共 DNS 与 Cloudflare 网段，再发放 10 分钟有效、绑定当前登录用户与候选配置的签名清单。浏览器随机排列候选，串行执行每个候选 3 次 1 KiB 请求和 1 次 256 KiB 下载。每个请求 6 秒超时。页面切到后台或网络中断，本次结果作废。

仅全部请求成功、标识和随机 nonce 一致、响应大小正确的候选可写入。分别在 IPv4 / IPv6 中寻找最低请求延迟；在距离最低延迟 15% 以内的候选中，优先选择短下载速率较高者。

页面的「请求延迟」是 `fetch` 开始到收到响应头的时间中位数，包含服务响应耗时；第一次可能含 DNS/TLS，后续可能复用连接。它不是 ICMP Ping 或纯 TCP RTT。「短下载速率」含请求启动开销，适合相对比较，不代表持续下载带宽；不同入口应使用相同的处理逻辑。

**写入**：重新验证登录、签名清单和候选 DNS，仅接受服务端清单中的候选 ID，不接受任意 IP 或域名。A / AAAA 通过一次 Cloudflare DNS batch 请求创建或修改，然后读取核对。操作在 API 数据库中批量执行，但各 DNS 记录的全球传播并不原子。

- 没有记录时创建；已有一条对应记录时修改。一个地址族没有成功结果时保留该类型原记录。
- 存在 CNAME/NS 冲突、同类型多条记录或受管理记录时停止，不自动删除任何记录。
- API 拒绝、超时、读回不一致时明确显示错误。请求中断后的状态可能不确定，请刷新查看「当前 DNS 记录」再操作。
- 重复提交相同结果不会产生不同 IP；相同记录已符合要求时不再修改。签名清单不是一次性锁，不提供跨管理员的串行事务；同时操作按最后一次成功修改为准。
- 写入频率限制为每用户每分钟 5 次；Cloudflare Rate Limiting binding 按边缘位置计数，不是全局分布式锁。
- 客户端上报的速度不是可信证明；只有管理员可以写入，签名清单限制候选范围与有效期。

## Cloudflare DNS 的边界

本项目始终提交 `proxied: false`。橙云会返回 Cloudflare 分配的代理地址，不能固定到所测 IP。Cloudflare 的 DNS 文档也对使用 Cloudflare IP 作为 A/AAAA 目标有限制说明；本项目不保证你的账户会接受任意 Cloudflare IP。如 API 拒绝，会显示原始错误码并停止，不声称写入成功，也不自动切换 DNS 提供商。

`cf-best-ip.thanejoss.com` 是供代理客户端查询的连接地址；实际使用时仍须保留你的代理 Worker 原有 TLS SNI、HTTP Host 和路径。入口测速不代表所有反向代理后端吞吐量，也不保证原代理服务支持该 IP。

## 开发与验证

```bash
npm ci
npm run check     # Wrangler 生成平台类型 + TypeScript + 浏览器脚本语法
npm test          # DNS 写入与拒绝场景、签名、来源校验、测速真实性
npm run build    # 本地打包，不部署或修改真实 DNS
```

测试使用内存响应和虚构凭据，不调用真实 DNS 修改。`.dev.vars.example` 仅为开发凭据格式示例；不存在绕过 Access 的生产开关。`npm run dev` 可预览静态页面，本地 API 仍要求有效的 Access 配置与 JWT。

官方参考：[Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)、[Static Assets](https://developers.cloudflare.com/workers/static-assets/binding/)、[DNS records](https://developers.cloudflare.com/dns/manage-dns-records/reference/dns-record-types/)、[DNS batch changes](https://developers.cloudflare.com/dns/manage-dns-records/how-to/batch-record-changes/)、[Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)、[Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch)。
