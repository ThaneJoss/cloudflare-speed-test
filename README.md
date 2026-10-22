# Cloudflare Speed Test

页面包含 **静态 IP 候选** 与 **HTTPS 探针实测** 两部分。内置 Cloudflare 官方网段，即使 `probes.json` 为空也能每轮生成 **10 个 IPv4 + 10 个 IPv6，共 20 个不同的候选 IP**。真实测速仍从已配置 HTTPS 探针中抽取十个，由浏览器测量，完成后可手动写入 DNS。没有数据库、定时任务或历史统计。

| 项目 | 配置 |
| --- | --- |
| GitHub | `ThaneJoss/cloudflare-speed-test` |
| 页面 / Worker Custom Domain | `cf-speed-test.thanejoss.com` |
| DNS 写入目标 | `cf-best-ip.thanejoss.com` |
| 记录类型 | A / AAAA |
| 代理与 TTL | DNS only（灰云），300 秒 |

## 内置静态 IP 候选池

[`data/cloudflare-cidrs.json`](data/cloudflare-cidrs.json) 保存 **15 个 IPv4 CIDR、7 个 IPv6 CIDR**，核对日期 **2026-10-12**，来源为 Cloudflare 官方 [IPv4](https://www.cloudflare.com/ips-v4/) / [IPv6](https://www.cloudflare.com/ips-v6/) 文本清单。已与 XIU2 的 `ip.txt`、`ipv6.txt` 核对；该项目包含旧 IPv4 范围及嵌套 IPv6 网段，实际内置采用官方快照。不增加实时抓取或自动更新，后续可人工修改文件。

[`src/candidates.ts`](src/candidates.ts) 独立生成原始 IP，不依赖 `probes.json`。默认每轮 **10 个 IPv4 + 10 个 IPv6**：在各地址族内等概率选一个网段，然后在该网段内均匀随机选地址；各族分别去重，重复 IP 重抽，不用一个地址族补足另一个。IPv4 排除该 CIDR 的网络和广播地址。这是等概率选段策略，较小网段的单个 IP 概率更高，不是把所有网段地址混合后等概率抽样，也不表示网段优劣或网络质量。

IPv6 `/32` 有 `2^96` 个地址，`/29` 有 `2^99` 个。生成逻辑用密码学随机字节与 BigInt 直接计算地址偏移，至多处理十六字节，不展开全部地址。每轮都是重新抽样，前后轮允许重叠。生成十个 IPv6 候选不对用户线路的 IPv6 能力作判断。

`POST /api/candidates` 经过现有 Origin 与 Access 验证后返回这二十个地址，包含地址族、来源 CIDR 和 `reachability: "unknown"`。它不读取 DNS 凭据、不检查网络可达性，也不发放写入签名。页面的“重新生成 10 IPv4 + 10 IPv6”可独立使用；DNS API 故障或 HTTPS 探针为空都不影响候选算法。

`/api/status` 分别返回 `candidatePool` 网段元数据和 `probePool` HTTPS 配置状态。静态候选没有 URL、延迟或速率，页面始终显示“可达性未知 · 未测速”。生成候选不会使测速或写入按钮自动可用。

## 配置真实 HTTPS 测量

**静态候选来源已经内置；仓库尚无真实 HTTPS 测速入口，`probes.json` 仍为空。生成 IP 和完成指定 IP 的 HTTPS 测量是不同步骤，实测前需完成下面的入口配置。**

普通浏览器无法实现 `curl --resolve`，也不能任意覆盖 TLS SNI 或 HTTP Host。现有网页采用「固定 HTTPS 候选入口」方案，**不能扫描任意 Cloudflare IP**。需要已有的、可验证的「HTTPS 域名 ↔ 单个 Cloudflare IP」映射；一个普通 Worker Custom Domain，或给它新增一个灰云 A 记录，并不会自动提供这样的入口。

如果尚无这些入口，先准备入口基础设施。不能把 `https://104.16.x.x` 的证书错误或 `fetch(..., {mode: 'no-cors'})` 的完成时间当作成功测速。仓库提供响应处理示例，但不自动创建证书、Cloudflare for SaaS 自定义主机或改变现有 Worker 路由。

### 1. 配置真实 HTTPS 候选入口

编辑根目录的 `probes.json`，需要至少 **10 个不同 IP**，可以配置更大的入口池。不同域名指向同一个 IP 只算一个候选；IPv6 展开和压缩写法会先规范化再去重。以下两项仅演示字段格式，不构成完整候选池；域名不可直接使用，IP 也没有为你的网络实测过：

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

推送或创建 PR 后，由通用 GitHub CI 根据标准项目元数据发现检查，执行范围见下方“开发与验证”。确认部署授权后，可执行 `npx wrangler deploy`，或使用下面的 Cloudflare Builds 路径。

或者在 Cloudflare Workers & Pages 中连接此 GitHub 仓库，选择 **Worker 项目**，构建命令 `npm run check && npm test`，部署命令 `npx wrangler deploy`；在对应 Worker 中配置上面的两个 Secrets。固定入口仍须先通过 `npm run verify:probes`。这是 Worker + Static Assets 项目，不是仅上传 `public/` 的静态 Pages 站点。

此仓库的部署目标是 **`cloudflare-speed-test`**，与线上 Custom Domain 实际绑定的 Worker 一致。配置运行时 Secrets 时请核对这个 Worker；Workers Builds 的构建变量不能代替运行时绑定。

`wrangler.jsonc` 会绑定 `cf-speed-test.thanejoss.com`。目标 `cf-best-ip.thanejoss.com` 由写入按钮管理，不应绑定为本项目的 Custom Domain。

### PR 分支预览

Cloudflare Builds 的现有 PR 流程执行 `npm run build` 后，再执行 `npx wrangler preview`。锁定的 Wrangler 4.149.0 支持独立的 [`previews` 配置](https://developers.cloudflare.com/workers/previews/configuration/)：静态资源和兼容性设置保留在顶层，预览变量、密钥及资源不从生产配置继承。

仓库的 `previews.vars` 使用 `https://preview.invalid` 和空的 Access/DNS 配置，只用于验证分支打包与预览上传；不绑定 DNS Token、签名密钥或生产限流命名空间。预览 API 保持关闭：实际预览 Origin 的 POST 返回 403，状态读取及匹配占位 Origin 的请求在现有 Access 校验处返回 503，不发起探针或 DNS 请求。`npm test` 使用这份实际配置验证拒绝行为及零外联。

预览上传成功不代表存在可访问的 URL。当前 `workers_dev: false`、`preview_urls: false` 及生产 Custom Domain 保持不变；没有为了 PR 开启域名或导入生产 Access/凭据。若要浏览线上预览，需要管理员另行授权并按 [Cloudflare 预览 URL / Access 说明](https://developers.cloudflare.com/workers/previews/custom-domains/)启用受保护的预览地址；要验证真实 API，还需独立的预览 Origin、Access 应用和测试资源。不要把生产配置复制到预览，或通过关闭校验使其可用。

## 按钮行为

**测速**：每次请求均从规范化去重后的配置池无放回随机抽取 10 个，IPv4 / IPv6 合计 10 个，地址族比例随配置池。服务端只检查本轮这 10 个的公共 DNS 与 Cloudflare 网段；若其中一个未通过，明确返回本轮候选及原因，不偷偷补抽或缩减数量。全部验证通过后发放 10 分钟有效、绑定当前登录用户、本轮 10 个 ID 和候选配置的签名清单。浏览器随机排列这 10 个，串行执行每个候选 3 次 1 KiB 请求和 1 次 256 KiB 下载。每个请求 6 秒超时。页面切到后台或网络中断，本次结果作废。

不足 10 个唯一 IP 时页面明确显示当前数量，不宣称一轮已就绪。重复点击会独立重新抽样，但不同轮可以重叠；池正好 10 个时只会改变顺序，不会凭空产生新地址。本轮未抽到某地址族时会注明「未抽到」，不将其当成 IPv6 不可用的证据。某地址族的全部真实请求失败时则按原规则不选出结果，并保留已有 DNS。

静态网段、参考项目差异和真实测量边界见 [候选来源研究](docs/candidate-sources.md)。官方网段只说明地址归属；“重新生成 10 IPv4 + 10 IPv6”展示的原始地址不会自动成为这里的 HTTPS 探针，也不能直接写入。

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

质量 CI 使用极简[调用文件](.github/workflows/ci.yml)，以 `@main` 引用 [`ThaneJoss/github-ci` 的通用工作流](https://github.com/ThaneJoss/github-ci/blob/main/.github/workflows/ci.yml)，由 push、pull_request、merge_group 和 workflow_dispatch 触发。每次新运行使用当时 `main` 的版本，实际解析的提交以运行记录为准。调用不传 inputs、env 或 secrets，原独立 `check` job 已移除。

通用 auto 模式从 `package.json` 和锁文件发现 `lint`、`test`、`build`，并执行 JavaScript 语法检查和依赖审计。`check`、`test:runtime`、`test:e2e` 不属于自动发现名称，因此类型检查、workerd DNS 回归和浏览器/axe 验收需在云工作区单独执行，不能把 CI 的 NOT RUN 记为通过。实际覆盖以对应提交的 CI 报告为准。

项目保留以下脚本和测试源码。Node.js 主版本以 `.node-version` 为准，使用 `npm ci` 按锁文件安装：

| 命令 | 验证范围 |
| --- | --- |
| `npm run lint` | ESLint 检查 Worker、浏览器、脚本和测试代码。 |
| `npm run check` | 生成 Worker 类型，检查源码和 TypeScript 测试的类型，以及浏览器模块语法。 |
| `npm test` | 静态 CIDR 候选、巨大 IPv6 偏移、唯一性、DNS、签名、测速真实性、静态资源响应/路由及预览隔离回归。 |
| `npm run test:runtime` | 在隔离 workerd 中验证 DNS 请求。 |
| `npm run build` | 打包 Worker 与静态资源；使用 `--dry-run`，不部署。 |
| `npm run test:e2e` | Chromium 桌面/手机交互、键盘导航、320px 布局、浅色/深色与 axe 无障碍检查。 |

浏览器测试使用回环地址的静态资源服务器，执行真实 `app.mjs` / `measure.mjs`，拦截 API 和测速响应；未识别的外部请求会中止并使测试失败。覆盖候选独立生成、十探针测速到模拟写入、入口验证失败和登录失效，不读取真实凭据、不访问真实探针、不写线上 DNS。首次在云工作区运行浏览器检查前安装 `npx playwright install --with-deps chromium`。截图保存在 `test-results/`，HTML 报告保存在 `playwright-report/`，失败时另含 trace；通用 CI 不自动安装浏览器或上传这些制品。

页面的浅色配色、字体栈、间距和卡片参考 `ThaneJoss/webapps` 的 `main`（`994a749aecb7f9143d1d180ce86e3ba5e6632149`），保留本工具的深色偏好支持与测速/DNS 流程。候选表格支持键盘聚焦和滚动，窄屏结果卡使用单列布局。源码仍保持 `public/` 原生 HTML/CSS/模块脚本，无需引入页面框架。

上述检查可在云工作区执行，不需要在用户机器上运行；尚未推送的修改不能声称 CI 已通过。`npm run verify:probes` 属于配置真实入口后的手工外部检查，不在自动 CI 中执行。

测试使用内存响应和虚构凭据，不调用真实 DNS 修改。`.dev.vars.example` 仅为开发凭据格式示例；不存在绕过 Access 的生产开关。`npm run dev` 可预览静态页面，本地 API 仍要求有效的 Access 配置与 JWT。

## DNS API 故障定位

Worker 的 DNS 请求使用 `redirect: 'manual'` 并显式拒绝所有 3xx。workerd 对 `redirect: 'error'` 会在发送请求前抛出 `Invalid redirect value`；把全局 `fetch` 保存到对象后通过对象方法调用还会抛出 `Illegal invocation`，因此客户端先取出函数再独立调用。浏览器脚本仍可使用标准的 `error` 模式。`npm run test:runtime` 会分别复现两个旧错误，再测试实际 `DnsClient` 的成功读取、重定向拒绝、API 拒绝和非 JSON 响应。

DNS 请求失败会写入 `dns_api_failed` 结构化日志，包含错误分类、读取或写入操作；收到上游响应时还包含 HTTP 状态、Cloudflare 错误码及 CF-Ray。不记录 Token、Authorization、请求体或原始异常文本。`/api/status` 在登录验证后分别返回候选配置与 DNS 状态：读取失败时 `records` 为 `null`、`dnsError` 说明原因；成功但无记录时为 `[]`。已有真实候选时仍可测速，读取失败时写入保持不可用。空 `probes.json` 始终禁止测速，并明确显示配置提示。

官方参考：[Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)、[Static Assets](https://developers.cloudflare.com/workers/static-assets/binding/)、[DNS records](https://developers.cloudflare.com/dns/manage-dns-records/reference/dns-record-types/)、[DNS batch changes](https://developers.cloudflare.com/dns/manage-dns-records/how-to/batch-record-changes/)、[Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)、[Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch)。
