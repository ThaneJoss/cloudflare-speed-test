# 10 IPv4 + 10 IPv6 云环境验证记录

## 来源与范围

本次从 `ThaneJoss/cloudflare-speed-test` 最新 `main` 独立检出，起点为 `85225f602f2256bdfb56110c8d2ab6d348e69835`。没有修改预装 `webapps`。独立检出及上级目录没有适用的 `AGENTS.md` 或 `.agents/skills`。

此前云任务的 `/workspace/cfst-10v4-10v6-review.patch` 与验证文档不在当前环境中；当前可用工具没有旧任务文件读取或 Library 搜索入口。本次依据当前源码独立实现，没有读取、应用或比对旧补丁。

静态候选每轮生成十个 IPv4 和十个 IPv6，共二十个，各地址族分别去重，重复在本族重抽，不跨族补足。保持静态 CIDR、密码学随机数、IPv4 网络/广播地址排除和 IPv6 BigInt 偏移算法。同步 API 元数据、页面介绍及生成按钮、状态提示、README、来源说明和回归用例。

## 本地验证

环境为 Node.js `v24.19.0`、npm `11.9.0`；依赖按原有锁文件安装，没有修改依赖清单或锁文件。初次安装因默认缓存目录不可写失败，改用 `/tmp` 中的任务缓存后 `npm ci` 成功。

| 验证 | 结果 |
| --- | --- |
| `npm run check` | 通过；生成 Worker 类型，TypeScript 与前端语法检查通过 |
| `npm test` | 60 项通过，0 失败，0 跳过 |
| `npm run test:runtime` | 通过；workerd 中复现旧 DNS 请求问题，并验证读取、重定向拒绝、API 拒绝及异常响应处理 |
| `npm run build` | 通过；执行既有 `wrangler deploy --dry-run` 构建，没有部署 |
| `git diff --check` | 通过 |

回归覆盖每族十个唯一地址、各族重复重抽、IPv4 可用范围边界、无偏拒绝抽样、IPv6 大偏移、每轮新随机数、二十个原始候选响应、候选与探针状态区分、空探针独立生成、前端未知/未测速展示、Origin/Access 校验，以及原始地址无法成为可写探针。

## 实测与安全边界

以上是代码、界面和隔离运行时验证，没有向随机候选发送逐 IP 网络请求，没有产生延迟、吞吐量、排名或网络可达性结果。原始候选仍为 `reachability: "unknown"`，不带 HTTPS URL、速度或写入令牌；页面显示“可达性未知 · 未测速”。生成候选不会自动启用测速或 DNS 写入。

`probes.json` 仍为空。既有真实 HTTPS 探针流程仍为 IPv4/IPv6 合计十个，需要独立配置并验证固定 IP 的 HTTPS 入口，才可由用户浏览器实测。本次没有解决普通浏览器任意指定远端 IP 的连接限制。

Access/Origin 保护、用户与清单绑定的授权签名、探针公共 DNS 和 Cloudflare 归属验证、写入前再次检查，以及 DNS 只更新实际选择地址族的逻辑保持原样。workerd 回归的 DNS API 使用隔离测试响应，没有真实 DNS 写入；本次未修改 DNS、Access、凭据或网络配置。

## 发布跟进

用户已明确授权本次正常推送，沿用现有 `main` 发布流程，不强推。推送前查询显示 `main` 未保护，既有工作流为 GitHub `Check` 和 `Workers Builds: cloudflare-speed-test`。推送后的 CI 和自动构建应按本次精确提交查询，结果链接在交付报告中提供；本记录不把旧提交成功当作本次成功。没有另行手动部署。
