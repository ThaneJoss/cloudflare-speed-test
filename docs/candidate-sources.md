# 候选来源与固定 IP 测速路径

核查时间：2026-10-12。官方静态网段已经写入 `data/cloudflare-cidrs.json` 并用于生成原始候选 IP；候选 IP 不代表可用 HTTPS 探针，`probes.json` 仍为空。

## 采用的官方来源

Cloudflare 将 [IP Ranges](https://www.cloudflare.com/ips/) 指定为当前 IP 范围的官方来源，同时提供 [IPv4 文本](https://www.cloudflare.com/ips-v4/)、[IPv6 文本](https://www.cloudflare.com/ips-v6/) 和 [公开 IP API](https://developers.cloudflare.com/api/resources/ips/methods/list/)。核查时分别为 15 个 IPv4 CIDR 和 7 个 IPv6 CIDR。

候选生成仅使用上述静态快照，不抓取远程来源、不增加自动更新。每轮默认八个 IPv4、两个 IPv6；各地址族先等概率选段，再在段内取随机偏移，IP 重复时重抽。IPv4 排除该 CIDR 的网络和广播地址；IPv6 用 BigInt 处理最多 99 位的主机偏移，不枚举 `2^96` 或 `2^99` 个地址。各 CIDR 的入选概率相同，段内地址数不同时，单个 IP 的概率不同。

已有 HTTPS 探针实测路径仍在 `/api/plan` 中读取官方 IP API，以验证探针归属；这是既有安全验证，没有变成新候选来源或更新机制。官方范围并不列出每个地址是否支持某个 HTTPS 域名；特别是从宽 IPv6 范围生成地址，并不等于该地址已配置服务。

## 两个参考项目的原始实现

重新读取 XIU2 后计数为 IPv4 25 行、IPv6 97 行。IPv4 旧 `104.16.0.0/12` 比官方多包含 `104.28.0.0/14`，同时该项目未覆盖官方 `172.64.0.0/13` 的部分地址。IPv6 表有 67 个 `/48` 被同表的 `2606:4700::/32` 包含；按行直接抽样会重复赋予这些范围权重。因此本项目内置的二十二项直接取自官方原始文本，不复制 XIU2 的清单或源代码。

| 项目 | 原始候选与抽样 | 指定 IP 的实际连接 | 复用说明 |
| --- | --- | --- | --- |
| XIU2/CloudflareSpeedTest | [ip.txt](https://github.com/XIU2/CloudflareSpeedTest/blob/master/ip.txt) 是 CIDR，IPv6 表含嵌套网段；默认先测大池延迟，排序后下载前 10 个，非随机十选一轮 | 本机 Go CLI 的 [DialContext](https://github.com/XIU2/CloudflareSpeedTest/blob/master/task/download.go#L103-L113) 直接连 IP，同时请求 URL 保留原域名 | [GPL 第 3 版](https://github.com/XIU2/CloudflareSpeedTest/blob/master/LICENSE)；本项目仅引用研究，不复制源码或地址表 |
| mydearniko/speedflare | [IPv4](https://github.com/mydearniko/speedflare/blob/main/internal/location/location.go#L25-L44) 为内置 7 段，有放回抽样；[IPv6](https://github.com/mydearniko/speedflare/blob/main/internal/location/ipv6.go#L135-L269) 汇总窄段、seed 与实时 AAAA 后去重 | 本机 Go CLI [直连目标 IP](https://github.com/mydearniko/speedflare/blob/main/internal/client/client.go#L412-L475)，TLS ServerName 与 HTTP Host 保持 speed.cloudflare.com | 当前树未发现许可证文件，仓库 API 的 license 为 null；不复制其源码或列表 |

XIU2 的 IPv4 原文件仍含 `104.16.0.0/12`。Cloudflare 官方变更记录说明，2021 年已将该段移除，改为 `104.16.0.0/13` 和 `104.24.0.0/14`；这就是不能直接把第三方原文件当成当前官方池的具体例子。其 IPv6 `/32` 与内部 `/48` 还可能生成重复 IP，需要自行规范化去重。

speedflare 的正式测速客户端默认验证 TLS，但 [候选位置发现探针](https://github.com/mydearniko/speedflare/blob/main/internal/location/location.go#L298-L310) 硬编码跳过证书验证。本项目不采用这个行为。XIU2 的相关 `InsecureSkipVerify` 设置处于注释中，并未启用。

本轮抽样算法独立实现，使用运行时密码学随机数和无放回抽样，没有复制上述项目的抽样代码。第三方许可证记录仅描述当前仓库声明；若以后引入其源码或列表，应重新审查授权和相应义务。

## 当前网页已经实现的范围

静态候选来源已经实际入库。`data/cloudflare-cidrs.json` 保存十五个 IPv4 和七个 IPv6 网段、来源链接、核对日期及参考文件链接。`src/candidates.ts` 独立计算十个唯一原始地址，API 不依赖 HTTPS 探针池，页面显示“可达性未知 · 未测速”，没有 URL、速度或写入令牌。

此前仓库没有静态 CIDR 数据文件，只有来源文档与调用官方 IP API 的探针验证逻辑。`src/sampling.ts` 操作的是从 `probes.json` 读取的 Probe 对象，所以空池无法抽样；它没有读取第三方表或生成 IP。当前保留该模块作为真实 HTTPS 探针的单独抽样逻辑，并补上独立的原始 IP 候选生成。

管理员提供真实 `HTTPS 域名 ↔ 单个 IP` 入口池。每个入口仍需 DNS、受信任 TLS、正常响应和 CORS；服务端先规范化去重，再为每轮独立随机抽取 10 个，并校验这 10 个的 DNS 和官方 IP 归属。下载与计时由用户浏览器执行，Worker 只验证配置、发放签名和处理经授权的 DNS 操作，不测量或代报用户速度。

浏览器没有 Go 的 DialContext。标准 [Fetch RequestInit](https://fetch.spec.whatwg.org/#requestinit) 不暴露目的 TCP IP 或 TLS ServerName 选项，且 [Host 属于禁止自行设置的请求头](https://fetch.spec.whatwg.org/#forbidden-request-header)。因此仅添加官方 IP 表不能补足缺失入口。浏览器也无法报告真实远端 socket 地址，代理、DNS64 或本机 DNS 改写可能影响实际路径；保留已有 DNS、响应标识、nonce、大小及替代路由检查。

## 完整任意候选 IP 的本机测速方案

推荐单独的本机命令行 helper，先以命令行方式交付，避免先引入浏览器到本地 HTTP 服务的跨域接口。

1. 获取当前官方网段与来源信息，规范化候选池，明确候选不是已验证服务。IPv4 可从允许的段内生成候选；IPv6 优先使用有来源的活跃候选再验证归属，不把宽段随机地址当成可用服务。
2. 每次独立无放回抽 10 个唯一 IP。helper 在用户的 Windows 本机运行，自定义拨号固定目标 `IP:443`，HTTP URL、Host 与 TLS SNI 使用选定的真实测速服务域名；保持证书链及域名验证，不开启 insecure 或忽略证书错误。
3. 分别记录各 IP 的 IPv4/IPv6、连接和 HTTP 延迟、下载量、耗时、TLS/网络失败及真实请求结果。没有 IPv6 路由或某地址不提供该域名时明确失败，不生成替代分数。若使用代理，结果明确属于该代理出口。
4. 把结果导出为可检查的本地文件。若需要网页导入并写 DNS，还要扩展服务端计划与结果协议，让签名清单绑定本轮这 10 个原始 IP；当前写入协议绑定的是已配置 Probe ID，不能直接把 helper 报告冒充现有 probe 结果。
5. 若以后选择网页调用本地服务，需要额外设计仅监听回环地址、严格来源/会话验证和受控接口，并处理浏览器本地网络访问要求；不默认开放网络接口。

这条完整路径仍需开发并批准 helper 的取得/安装与运行、选择真实 HTTPS 测试服务和协议，以及决定是否扩展网页导入/写入。当前授权内没有安装或启动 helper。

保留纯网页则需准备至少 10 个真实的固定 IP HTTPS 入口，并在更大池中配置后抽样。新增域名、证书、Cloudflare for SaaS、自定义路由或 DNS 都要在具体方案核实后另行批准；新增普通灰云 A 记录不会自动保证证书和边缘路由。
