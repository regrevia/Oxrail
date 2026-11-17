# ADR-BROWSERCTL-001 — Opt-in Browser Control 路由（MCP / CDP）

状态：已决策；实现随 `packages/browser-control/` 落地，产品版本号由 release 流程决定。真实宿主证据范围见文末“证据边界”。

来源：用户在 `0.1.0-alpha.6` 范围内明确要求增加一条**可显式启用**的 Browser Control 路由，用于宿主原生 Computer Use 不可用或不适用的场合（headless、CI、本地页面检查、自动化复现）。本记录按 §30.4 回答五个问题，是 SEC-52 与 GATE-G16 的前置决策，不重新比较产品方向。

## 背景

本规范的既有禁令（§2.4、§2.5、§30.3、§47.2、WP-V1-002）禁止把 Oxrail 做成 Browser Agent、Playwright wrapper 或通用 CDP write transport，也不允许用 CDP 代替 Native Computer Use 发起写命令。理由是：一旦 Oxrail 获得默认写执行权，就同时失去 thin interposer 定位与 Native remains executor 的公开声明。

但这些禁令把“默认”与“可显式配置的附加 surface”混在了一起，导致另一类真实需求没有诚实出口：在没有宿主 Computer Use 能力的环境里，既不能使用 Oxrail，也无法用同一套理由宣称任何浏览器路径。单纯禁止不能回答“这些环境怎么办”，只会把用户推向未治理的绕行方案。

## 决策

1. **opt-in**：路由只通过宿主显式配置的 MCP server 暴露。未配置时不存在任何工具、不启动进程、不注册 Hook。
2. **默认关闭且永不成为默认**：不进入默认安装路径，不自动发现，不因环境变量把普通安装变成 Browser Control 安装；`OXRAIL_*` 环境变量只在该 server 已被宿主启动后生效。
3. **自有浏览器进程**：路由自行启动并持有 Chromium（独立 profile 目录），不接管、不连接、不注入使用者正在使用的浏览器，也不拥有页面 write/debugger 权限之外的东西。Native 路由不 import 该 package，因此不获得任何 CDP 依赖。
4. **MCP stdio surface**：能力以 MCP 工具暴露（open / read / click / type / key / nav / shot / state / login / close），由 MCP 客户端决定是否加载；不新增 Hook 事件，不改 hook trust，不写 `permissionDecision`。
5. **不作任何 Hook/Safety 声明**：路由内部的动作不是 Hook-visible，也不得被报告为经过 Oxrail Guard、Safety 或 Credential Enclave。ADR、SEC-52、Doctor 与 README 必须同口径。
6. **不替代 Native Computer Use**：路由不是 Native 路由的 fallback、加速器或“更可靠的实现”。同一任务上不得把两者的结果混算成 Native 或 Oxrail 的净收益。
7. **可回收**：空闲浏览器由路由自己回收（默认 5 分钟，`OXRAIL_BROWSER_IDLE_MS` 限制在 60 秒–15 分钟），但在使用者仍在观察时不得回收；`state` 必须报告 `pid`、`profile`、`idleMs`、`closesInMs`。启动即死亡必须按毫秒级报错，不能等满端口超时。
8. **登录态按 profile 持久化**：正常关闭走 `Browser.close`，让 cookie 落盘；不同 profile 互不可见，不提供跨 profile 导出。

## §30.4 的五个问题

**1. 哪个已量化瓶颈无法由现有方案解决。**
没有任何现有方案覆盖“宿主没有可用的 Computer Use，但使用者仍需要可审计的浏览器读写路径”。本路由启用该场合，但它本身不是瓶颈修复：因此不宣称它更快、更省 token 或更可靠，也不作为任何 benchmark headline 的 variant。

**2. 对权限、攻击面、安装和 NIF 的影响。**
新增一个 production package，它拥有 CDP 连接与自有 Chromium 进程；新增的 MCP 工具面只对显式配置它的宿主可见。不新增 Hook 事件、不申请扩展权限、不读取宿主浏览器数据。原生路由与 NIF 用例不加载该 package，故既有 NIF 结论不受影响；该路由也不进入 B0–B6 variant，不参与 paired benchmark。安装形态与产品清包审计列为 WP-BCTL-001 的验收项，不在本 ADR 里预先宣称通过。

**3. token/延迟的净成本。**
默认关闭时为零：无进程、无工具、无 Hook。启用时每次读取受 `maxChars` 上限约束（默认 6000，下限 400），控件编号受上限约束；额外成本是 Chromium 进程的内存与启动延迟。本文不给具体数字——未测量前不写数字。

**4. 可删除路径。**
删除该 package、从宿主 MCP 配置移除对应条目、删除 state 目录下的 profile 与截图；无数据迁移、无格式升级。规范层面把 SEC-52 标为 withdrawn、删除 GATE-G16 与 WP-BCTL-001、保留 KILL-K34 并把本 ADR 标为 superseded（保留历史，不复用 ID）。

**5. 对应 Work Package、Benchmark 与 Kill Criteria。**
`WP-BCTL-001`；benchmark 为独立对照（同 task 下 opt-in 路由与 Native 的成功率、延迟、误报），不并入 NIF；`KILL-K34`：路由在未显式启用时可达，或被报告为 Hook-visible / 与 Native 等价时，必须杀死该路由的相应声明。

## 后果

- 正面：无 Computer Use 的宿主获得一条默认关闭、可审计、可整体删除的出口；产品定位与既有禁令保持不变。
- 负面：多一个 production package 与一条长期维护的 CDP 路径；Chromium 版本漂移、profile 损坏、异常退出时的 cookie 丢失都需要单独维护。
- 中立：路由的存在不改变 Native 路由的任何声明；两者的能力矩阵必须分别记录，不得合并。

## 被否方案

- **Playwright MCP**：引入 Playwright 依赖（`scripts/lint.mjs` 明确禁止 `packages/**` 依赖 Playwright/puppeteer/chrome-remote-interface），且其进程模型与 profile 回收策略不受我们控制，无法给出上面的回收与启动失败保证。
- **上游 Chrome DevTools MCP**：权限模型、版本与回收行为由第三方决定，无法保证“自有进程、不接管使用者浏览器、可整体删除”。
- **直接依赖 Native Computer Use**：这是默认路由本身，不是本需求的替代方案；在没有该能力的环境里它不存在。
- **默认开启的 CDP write transport**：这正是既有禁令所禁止的漂移（KILL-K12），不予考虑。

## 证据边界

写本文时以下事项**未**在真实宿主上验证，任何文档不得把未验证项写成已支持：

- Codex 是否从 `.mcp.json` 自动加载该 server，以及安装后用户是否必须重启宿主；
- Codex 工具结果是否渲染 image block（截图工具返回的图片是否可见）；
- 是否有任何 benchmark 数字；
- Windows/Linux 上的 Chrome/Chromium 发现路径；
- profile 保存登录在异常死亡（非 `Browser.close`）时的完整性。

已验证的部分限于仓库内可重复的代码路径与测试（见 `packages/browser-control/` 与 `TEST-BCTL-001`–`TEST-BCTL-004`）。缺少真实宿主证据时，状态只能是 IN_PROGRESS / BLOCKED，不能是 ACCEPTED。
