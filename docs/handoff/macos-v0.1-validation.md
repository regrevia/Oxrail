# macOS ChatGPT：V0.1 实机验证与 Benchmark 交接

> 状态：待执行的 alpha 验证交接，不是通过报告。本文没有证明 Oxrail 已在任何真实 ChatGPT、Codex、Chrome 或 Computer Use 组合上可用，也不授权发布、合并 `main` 或创建版本标签。

本文供一台具备 ChatGPT macOS 桌面应用、Codex 与 Chrome Computer Use 的实机使用。产品行为、验收阈值和证据格式只以固定 commit 中的 [`spec/OXRAIL_SPEC.md`](../../spec/OXRAIL_SPEC.md) 为准；本文只是执行手册。如本文与该文件冲突，立即停止并按规范记录 blocker，不要临场修改口径。

## 交接边界

- 从远端 `dev` 冻结一个 40 位 alpha commit；代码、插件内容、fixture、任务集和分析逻辑在整轮实验中不变。
- 安装 Oxrail 后，由用户在宿主 `/hooks` UI 中逐项 review 并 trust 当前 Hook definition hash。不得代替用户授权，不得使用任何跳过 trust 的选项；Hash 改变后仍走宿主重新授权。
- 安装或更新插件后必须开启新会话，确保 Skill/工具按宿主规则重新加载。
- 新会话先完成真实 host inventory、bootstrap 和无副作用 doctor。doctor 不得 click、type、navigate，也不得把用户下一次真实任务当成安装测试。
- 若宿主有无害 synthetic probe，可用 neutral/pass-through probe 验证通用 Hook path；除非宿主明确证明其等价于目标 Chrome Computer Use route，否则不能据此把真实 matcher 标为 VERIFIED。
- 若只有真实 Browser 调用能确认 matcher，doctor 保持 `CONFIGURED` 和 `READY — awaiting first native browser call`。不要为验证额外制造调用；在后续已获明确同意的受控 fixture benchmark 自然出现第一次调用时，只被动记录并原样透传。
- Hook 不可用时必须 fail-open：原生 Chrome Computer Use 继续，Oxrail 显示 `optimization unavailable / BYPASSED`。未被实证的 Safety/Handoff 始终显示 `INACTIVE` 和原因。
- 所有 Browser 行为只发生在本地受控 fixture 和专用测试 profile。禁止真实账号、生产站点、真实密码、OTP、Cookie、Token、支付信息或登录截图。
- 实验由 coordinator 编排隔离 runner 子 agents；每个 `model × arm × repeat` 使用全新子 agent 和新 thread。runner 不能读取另一 arm 的结果/轨迹，aggregator 只能在全部 runner 结束且 artifact 已去敏后读取结果。

官方宿主资料用于确认公开安装与权限流程，不能替代实机证据：

- [Computer Use in ChatGPT](https://learn.chatgpt.com/docs/computer-use)
- [Plugins](https://learn.chatgpt.com/docs/plugins)
- [Hooks](https://learn.chatgpt.com/docs/hooks)
- [ChatGPT & Codex changelog（2026-08-25）](https://learn.chatgpt.com/docs/changelog#codex-2026-08-25-browser)

不把 Codex Hooks 的结论外推到 ChatGPT Web；本轮只声明实际 inventory、HostProfile 和 trace 证明的 surface/build/route。

## 手动 Chrome same-tab 原语 probe

仓库包含一个独立的、非授权 MV3 probe，用于在 macOS 的受控 fixture 中检查 Chrome 是否会移动、聚焦并恢复**同一个现有 tab 对象**。它不是安装验证、Host Handoff verifier 或真实任务测试，不能签发 Host receipt，也不会把 Handoff/Credential protection 变成 `ACTIVE`。

在固定 commit 的源码 checkout 中运行：

```bash
pnpm build
pnpm fixture:serve
```

然后由用户在用于实验的 Chrome profile 中人工执行：

1. 打开 `chrome://extensions`，启用 Developer mode，选择 Load unpacked，并加载固定 checkout 的 `dist/handoff-control`。不得用策略或脚本静默安装。
2. 在扩展卡片中打开 service-worker inspector；它只用于接收下面的去敏单行 JSON。
3. 打开 `http://127.0.0.1:4173/`，或 harness 返回的、只含一个 64 位小写十六进制 `reset` 参数的 URL。不要在真实账号、日常 profile 或其它页面运行。
4. 在该 fixture tab 处于活动状态时，人工点击 Oxrail 扩展按钮一次。按钮是唯一入口；网页、Agent 和外部进程都不能传入 tab ID 或触发 probe。
5. 在 service-worker inspector 中等待以 `OXRAIL_SAME_TAB_PROBE` 开头的单行 JSON；没有该行即视为未取得结果。扩展不会在其它页面保留 badge/title 状态。只同步该去敏结果和 `dist/handoff-control/build-evidence.json`，不同步浏览器页面、tab/window ID 或截图。

成功结果仍必须包含：

```text
authority = FIXTURE_ONLY_NON_AUTHORIZING
chromeTabObjectContinuity = PASSED
fixtureUrlStable = PASSED
documentBinding = UNKNOWN
hostNativeActionFence = UNAVAILABLE
hostTabRouteBinding = UNKNOWN
handoff = INACTIVE
capabilityEffect = NONE
```

该 probe 只有一次性 `activeTab` 权限，没有 host permissions、content script、storage、native messaging、Cookie、history、clipboard、capture 或 debugger 权限。它只证明运行该扩展的 Chrome profile 中存在 window/tab 原语；它不能证明该 tab 属于当前 Computer Use route、Host 已暂停 Agent 路径、原任务能自动 continuation，或满足 `REQ-HO-017`/`GATE-G9`。

## 固定实验设计

### 变体、pair 与三阶段成本

所有阶段都只比较同一模型内的两个变体：

- A：`Native Tuned`，使用宿主当前安全的原生优化，但不加载 Oxrail 行为。
- B：同一套 Native Chrome Computer Use 加固定 commit 的 Oxrail；`BENCH-NIF` 中 B 必须是 ordinary pass-through。

`5 pairs` 的含义固定为：对同一个任务运行 Native Tuned 5 次和 Oxrail 5 次，共 10 arms；不是总共 5 arms。它只属于最终 release 矩阵。[`SEC-31.5`](../../spec/OXRAIL_SPEC.md#sec-31) 的 3 pairs 是 nightly 级，不能冒充 release evidence。

成本按三道人工 gate 递进：

1. **Pilot 0 — Luna-first：** 只用 `gpt-5.6-luna`；默认 4 个 Browser sentinel、每项 1 A/B pair，共 8 arms。仅在预注册条件满足且特定能力仍为 `UNKNOWN` 时，最多启用 4 个 reserve sentinel，绝对上限 8 tasks/16 arms。
2. **Luna 3-pair subset：** Pilot 全过后只提出计划，不自动执行；它仍不是 release evidence。须用户另行批准，跑完并通过后再提出下一阶段。
3. **正式三模型矩阵：** 仅在前两阶段分别通过并获新批准后，使用 `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`，对正式 63 项中的每项运行 5 pairs/10 arms，另执行 Full SecretLeakBench。

首轮 Pilot 不要求两个模型，也不检查 Sol/Terra 的运行结果；Luna exact ID 不可用时 Pilot 直接 `BLOCKED`，不得替换。正式三模型矩阵才要求三个 exact IDs 全部可用；任一缺失都记录 `BLOCKED`，不得用相似名称或其它版本替换。始终记录宿主展示的精确 model ID、UI 标签、model/build 日期和 reasoning 设置。同一模型 A/B 设置必须完全相同，禁止以跨模型差异替代 A/B。

官方 2026-08-25 changelog 规定 Site tools（WebMCP）只适用于 GPT-5.6 Sol/Terra，不适用于 GPT-5.6 Luna；Luna 仍可使用 Browser control。因此 Pilot 的 A/B 都固定记录 `Site tools/WebMCP=unavailable by model contract`，不得尝试启用。后续 Sol/Terra 可各自采用实机确实可用且预注册的 Native Tuned site-tools 配置，但同一模型 A/B 必须一致；不得把 Sol/Terra 与 Luna 的 token/耗时差异归因于 Oxrail。

### Runner 隔离与盲化

- coordinator 只持有冻结的 preregistration、控制变量、随机 schedule、runner 输入和完成状态；它不把任一 arm 的结果/轨迹发给其它 runner。
- 每个 `model × arm × repeat` 至少一个全新 runner agent、`fork_turns=none`/无历史，并使用不同的 root parent thread/session。官方 Hooks 约束是 subagent Hook 事件报告 parent `session_id`，因此在同一 coordinator parent 下 fork 两个 sibling subagents 不构成 Oxrail session-state 隔离。
- coordinator 只能通过宿主已验证的跨 root task/orchestration 机制启动这些 runner；若需用户开启空白 root threads 并粘贴封存 runner packet，coordinator 必须 checkpoint 后暂停等待。不得为了省事从当前 coordinator 连续 spawn siblings。
- A/B 配对通过预注册的 `pair_id` 关联，不共享上下文。配对两臂不得由同一 thread 顺序执行，也不得让第二臂读取第一臂 artifact、对话、summary、trace 或结果。
- 若宿主能提供经验证的 per-arm state namespace，可用它作为不同 root session 的等价隔离，但必须先证明 Hook/profile/cache/state key 全部绑定 arm namespace、无跨臂读取，并由 reviewer 接受。否则只允许不同 root parent sessions。
- runner 只写自己的隔离暂存目录，完成后退出。coordinator 只收集不含指标内容的完成/失败 receipt，并先对 artifact 做机械去敏和 secret scan。
- 所有预注册 runner 完成或明确失败/缺失后，才启动一个全新 aggregator agent。aggregator 只读取通过去敏扫描的 artifacts，不能调用 Browser、重跑样本或修改原始结果。
- 只保存每个 root session 的随机 salt + digest，不保存原始 `session_id`。若本地 ChatGPT 只能在同一 parent session 下 spawn，Pilot gate 为 `BLOCKED`；不得并发运行、假装隔离、退化为共享上下文单 agent，也不能由 coordinator 兼任 runner 或 aggregator。

### 必须锁定的控制变量

同一模型每个 A/B pair 必须固定并记录：

- task prompt、task manifest、fixture revision/hash、seed；
- ChatGPT surface/build、Codex runtime/CLI、Computer Use plugin、Oxrail plugin/commit/Hook hash；
- macOS version/build/architecture、Chrome version/build、Chrome Computer Use extension version、browser path 和专用 profile 类型；
- 实际 tool route、matcher tool names、工具开关与批准策略；
- viewport、zoom、DPR、键盘布局/IME、locale、timezone；
- 网络、VPN/proxy、网络模拟、重试、超时和确认策略；
- 初始 tab、fixture 数据、conversation/context、Oxrail runtime/cache 状态。

每个 arm 后重置 fixture、tab、焦点、滚动、viewport、应用数据、对话上下文和 Oxrail 运行态；保留已经人工授予且 hash 未变的 trust。不得清除或改动用户日常 Chrome profile。若某一变量无法固定或观测，明确记录 `UNKNOWN`/blocker，不能猜值。

### 最终 release 实机矩阵（Pilot 不执行）

| Suite           | 范围                                         | 每模型执行                                                 | 不可抵消条件                                                                                                         |
| --------------- | -------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| HostReality     | `HR-39`–`HR-45` 全部                         | 每个不同 HostProfile 至少一次；模型改变 route 时重跑       | trust、passive first call、fail-open 和 truthful inactive 均有独立结论                                               |
| `BENCH-NIF`     | `TEST-NIF-001`–`023` 全量                    | 每项至少 5 个 Native Tuned/Oxrail pairs                    | semantic parity 100%；pointer/focus/scroll interference 0；normal false block 0；Oxrail page-write 0；stale target 0 |
| OxrailBench     | 固定 V0.1 30-task core                       | 每项至少 5 pairs                                           | success 不低于 Native Tuned 2pp；只报告实际启用模式，Guard-only 不宣称 token 收益                                    |
| StallBench      | 固定 V0.1 10-task core                       | 每项至少 5 pairs                                           | detection ≥90%；false positive <5%；匹配粒度的介入 ≤2；normal false block 0；success 不低于 Native Tuned 2pp         |
| SecretLeakBench | 固定 commit 中完整可执行集合与所有规定扫描面 | 每个模型/变体/重复都扫描；主动 canary 场景也做至少 5 pairs | 任一 Oxrail-owned canary occurrence 为 release fail；失败不得用平均值抵消                                            |

若仓库没有上述真实实机 harness、固定任务 manifest 或结果写入器，不得临时手工编造 PASS。记录缺口、保留已有结果并提交 `BLOCKED` evidence PR。

正式矩阵固定包含 `23 BENCH-NIF + 30 OxrailBench + 10 StallBench = 63` 项。减少这 63 项必须先修改唯一规范并明确缩小 V0.1 claim；不得由本 runbook、coordinator 或某次运行静默删项。三模型、每项 5 pairs 意味着 `3 × 63 × 5 × 2 = 1,890` 个 arms，尚未计入 Full SecretLeakBench。

Full HandoffBench 是规范中的 V0.4 范围，不是 V0.1 优势或本轮通过条件。V0.1 的 Safety/Handoff 必须明确 `INACTIVE`；本轮只验证 UI 如实显示 inactive、原生授权流程未被破坏，并可在受控假账号/fixture 上记录 Host/Handoff capability feasibility。没有真实 adapter 时该 lane 为 `NOT_APPLICABLE` 或 `BLOCKED`，绝不能写 `PASS`，也不能宣传“快速安全授权窗口”已实现。若宿主确实暴露可测试的 feasibility lane，只记录人工完成时长、人工步骤数、是否自动恢复、是否需要 chat continue 等原始事实，不形成能力 headline。

### Pilot 0 — Luna-first feasibility 与早停

Pilot 只回答“固定 alpha 是否值得进入下一轮”，不做统计推断，不报告性能优势，不发布 success/token/latency headline。

先完成**零 Browser 阶段**：固定 commit 安装、人工 `/hooks` trust、新会话、真实 inventory/bootstrap/doctor，以及 `HR-39`–`HR-45` 中不需要 Browser 的静态/状态检查。doctor 不得主动验证 Browser；`HR-42` 保持 READY 等待 Pilot 的自然首个调用，`HR-44` 留给下方已有 click fixture 复用。Secret smoke 优先扫描源码、配置、已有测试产物、Hook/stdin/stdout/temp/state schema 和之后生成的 Pilot artifacts，不为首轮另发 Browser action。

Pilot Browser sentinel 使用固定 ID：

| ID            | 默认/Reserve | 高信息场景                       | 主要回答                                                                                                                                                                |
| ------------- | ------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P0-LUNA-001` | 默认         | ordinary click + pass-through    | B 臂以 trusted Hook 做 HR-42 passive first call；A 臂保持 Native Tuned、令 Oxrail Hook unavailable 并显示 BYPASSED，复用同一 click 证明 HR-44 fail-open；不新增任务/arm |
| `P0-LUNA-002` | 默认         | typing 到非敏感 fixture          | keyboard/input envelope 与 normal false block                                                                                                                           |
| `P0-LUNA-003` | 默认         | click 后 rerender + stale target | revision/旧 target 是否失效                                                                                                                                             |
| `P0-LUNA-004` | 默认         | repeat no-progress               | 实际可见粒度上的 Guard/检测能力                                                                                                                                         |
| `P0-LUNA-R01` | Reserve      | vertical scroll                  | scroll route/interference                                                                                                                                               |
| `P0-LUNA-R02` | Reserve      | horizontal scroll                | axis/container fidelity                                                                                                                                                 |
| `P0-LUNA-R03` | Reserve      | drag                             | drag event/target fidelity                                                                                                                                              |
| `P0-LUNA-R04` | Reserve      | iframe                           | frame binding/coordinates                                                                                                                                               |

默认只跑 4 个任务，每项恰好 1 个 Luna A/B pair，即 Native 1 + Oxrail 1，共 8 arms。为尽早发现不可行，执行顺序固定为 `P0-LUNA-001 → P0-LUNA-004 → P0-LUNA-002 → P0-LUNA-003`；每个 pair 的 `AB`/`BA` 方向仍由预注册 seed 决定。只有默认 8 arms 均未失败、没有 P0/KILL、且预注册中点名的能力仍为 `UNKNOWN` 时，才按预注册次序启用必要 reserve；最多再加 4 tasks，总上限 8 tasks/16 arms。不得因失败而追加 reserve 或重复到成功。

早停检查点：

- 第一个 pair 后（2 arms）：必须证明 Luna exact ID、runner/thread 隔离、exact Browser route/matcher、固定 task manifest、reset receipt 和 schema-valid result writer；B 臂 input/result 原样透传，A 臂在 Hook unavailable 时 native click 成功且 UI 为 BYPASSED。
- 第二个 pair 后（累计 4 arms）：还必须证明该 route 上存在真实可执行而非 passive-only 的 Guard adapter，并确认 HR-44 复用 click 的 fail-open receipt、secret/static scan 和所有 P0/KILL 均无失败。
- 任一检查失败立即停止后续 Browser arms，manifest 写 `BLOCKED` 并收束证据。固定 alpha 若仍是 passive-only，必须在 Guard adapter gate 早停，不能跑 1,890 arms 来证明没有 Guard。

早停不改变正式计划：evidence 必须保留三模型正式 63 项的 planned denominator，并为未运行 model/suite/task/arm/repeat 写 `NOT_RUN` + reason。不得缩小分母、删除 Pilot 失败或把未跑项标成 PASS/NOT_APPLICABLE。

Pilot 的 4 个默认 sentinel（以及确有必要的 reserve）全部通过后，只生成一份 `gpt-5.6-luna` 3-pair subset 提案并暂停，等待用户另行批准；不得自动执行。获批的 Luna subset 通过后，再生成三模型、63 项、每项 5 pairs 的正式矩阵提案并再次暂停。只有新批准才能启动正式矩阵。

## HostReality `HR-39`–`HR-45` 取证要点

- `HR-39`：保存当前 Hook definition hash、人工 review/trust 的去敏文字证明和时间。更新/hash-change 部分只能在仓库外的隔离副本中改变无语义定义并验证宿主要求重新 review；不得改固定 alpha 源码。宿主不支持隔离验证则标记部分未证实。
- `HR-40`：doctor 逐项报告 plugin installed、skill available、hooks registered、hooks trusted、PreToolUse、PostToolUse、Chrome Computer Use、matcher/profile、Handoff capabilities 和 resulting mode。
- `HR-41`：只在宿主明确提供无害 synthetic probe 时运行，输出必须 neutral/pass-through 且无 Browser side effect；不支持时如实记为 `NOT_SUPPORTED`，不得以真实用户操作替代。
- `HR-42`：若真实 route 尚未验证，后续 benchmark 内自然发生的第一次 Oxrail Browser call 只记录 `first_browser_hook_seen=true`；input、result、调用次数和原生动作必须不被 block/rewrite/replay。
- `HR-43`：验证 `INSTALLED → CONFIGURED → VERIFIED` 的可重放转换。首次 Browser call 前允许停在 `READY — awaiting first native browser call`，不能把 READY 写成 VERIFIED。
- `HR-44`：复用 `P0-LUNA-001` 的 ordinary click fixture，在其预注册 fail-open 子步骤中受控禁用或令 Hook 不可用，证明 Native Browser action 仍成功且 Oxrail 为 `BYPASSED`；不另建 Browser 任务。随后恢复原配置，若 hash/trust 状态改变则再次人工授权。
- `HR-45`：对每个未实证 Safety/Handoff 能力检查 UI/doctor 明确显示 `INACTIVE` 及原因。不可用、部分可见或仅 advisory 都不能显示 ACTIVE。

## 证据与 Git 流程

建议把一轮证据放在：

```text
evidence/WP-RLS-010/<run-id>/
  checkpoint.json
  host-inventory.json
  host-profiles/
  setup-verification.json
  preregistration.json
  schedules/
  runner-inputs/
  runner-receipts/
  runner-artifacts/
  traces/
  results/
  reports/
  privacy-scan.json
  SHA256SUMS
  manifest.json
```

要求如下：

- 每个 arm 生成满足 schema version 4、`spec_version: "0.5.0"` 的 EvidenceTrace；每条 trace 关联 exact alpha commit、task、variant、pair/replicate、model、HostProfile 和 artifact hashes。
- 保存 coordinator/runner/aggregator 的隔离证明：每个 runner 的新 agent/thread、`fork_turns=none`/无历史、不同 root parent session（或 reviewer 接受的等价 per-arm state namespace）、salted session digest、仅含本臂输入的 hash、输出目录、开始/结束时间与 completion receipt；不保存原始 `session_id` 或另一臂内容。aggregator 记录启动时间，必须晚于最后一个 runner 终态和去敏扫描完成时间。
- HostProfile 必须来自该实机真实 inventory/bootstrap/doctor，绑定 surface + host build + Computer Use plugin + browser path + tool route + Hook definition hash；Host 或 Hook 变化后旧 profile 失效。
- `manifest.json` 必须包含 `work_package`、`status`、`commit`、`spec_version`、`environment`、`schema_hashes`、`host_profiles`、`commands`、`test_results`、`reviewers`、`sha256_manifest`、`accepted_at`、`blockers`。
- `SHA256SUMS` 使用 macOS `shasum -a 256` 生成，按相对路径稳定排序，采用 `64hex␠␠relative/path` 和 LF；覆盖 manifest 声明的全部 HostProfile 与 test result。`sha256_manifest` 是 `SHA256SUMS` 自身的 SHA-256。
- Pilot/Luna subset 通过只把总体 release manifest 保持为 `IN_PROGRESS`；Pilot 早停或 gate 失败写 `BLOCKED`，不能因正式矩阵尚未获准而伪造完成。只有正式矩阵和其它必测均完成时，执行者才可提交 `IN_REVIEW`。独立 reviewer 验证 hash、隐私、命令和全部 Acceptance 后，才可填写 reviewer/accepted_at 并转 `ACCEPTED`。
- 所有失败、timeout 和缺失数据都保留去敏 trace/reason code；不得删掉失败样本、改 task、换 seed、换模型、改阈值或只挑有利结果。修复后另开 run，不覆盖原 run。
- 原始 secret、真实账号标识、Cookie/Token、完整敏感 URL query、字段正文、剪贴板、按键、默认 screenshot、登录截图和 crash dump 不入库。SecretLeakBench 只使用规范的 synthetic canary 与 fixture。若原始失败材料本身敏感，安全隔离留存于本机，仓库只放去敏 failure record、hash 和 reason；仍不得把该失败删掉或改成 PASS。
- 证据先提交 `evidence/macos-v0.1-<date>-<shortsha>` 分支并创建以 `dev` 为 base 的 PR。失败也创建 draft/blocked PR 同步去敏证据。不得直接推 `main`。
- evidence PR 门禁和独立 review 通过后才可合入 `dev`。本轮已按每项至少 5 paired runs 执行仍不自动等于 release 通过；还须完成规范要求的其余正式 release regression，全部通过并复核后，才可从 `dev` 合 `main` 和创建 tag。

## 给 macOS ChatGPT 的完整可粘贴提示词

下方提示词设计为可重入：安装和人工 `/hooks` trust 后必须新开会话，再粘贴同一段；agent 从 checkpoint 恢复。首次粘贴前，将 Oxrail 仓库放在本机并确保能访问远端 `dev`。

```text
你现在是 Oxrail V0.1 alpha 的 macOS 实机验证执行者。你的任务不是开发或修代码，而是在一台具备 ChatGPT macOS、Codex、Chrome Computer Use 的实机上，严格验证 Skill/Hook 可行性并生成可审阅、去敏、可复现的 benchmark evidence。

唯一产品规范是本次固定 commit 内的 spec/OXRAIL_SPEC.md。先完整读取其中 SEC-09、SEC-10、SEC-12、SEC-31、SEC-32、SEC-33、SEC-34、SEC-36、SEC-38、SEC-39、SEC-40、SEC-42、SEC-43 和 WP-RLS-010。本文提示词与规范冲突时，以规范为准，记录冲突并停止相关步骤；不得临场降低 gate 或改变指标口径。不要声称当前 V0.1 已通过、已发布或可用于真实 secret。

宿主公开事实仅查官方 https://learn.chatgpt.com/docs/computer-use、https://learn.chatgpt.com/docs/plugins、https://learn.chatgpt.com/docs/hooks 和 https://learn.chatgpt.com/docs/changelog#codex-2026-08-25-browser；它们不能替代本机 HostProfile/trace。2026-08-25 changelog 是本轮 Luna Site tools/WebMCP unavailable、但 Browser control supported 的来源。

安全硬限制：
1. Browser 只使用受控本地 fixture 和专用测试 Chrome profile；不访问生产站点，不使用真实账号。
2. 只使用规范指定的 synthetic canary。原始密码、OTP、Cookie、Token、卡号、账号标识、完整敏感 URL、字段正文、按键、剪贴板、登录截图和未去敏 crash dump不得写入仓库、模型上下文或 evidence。
3. 不代替用户授权 Hook，不使用任何跳过宿主 trust 的选项。初次安装以及 Hook definition hash 改变后，必须由用户在 /hooks UI 人工 review + trust。
4. doctor 不发起 click/type/navigation，不为了安装验证强制真实 Browser 调用，也不把用户下一次真实任务当 installation test。
5. Hook 不可用或失败时必须 fail-open，让原生 Chrome Computer Use 继续；Oxrail 显示 optimization unavailable / BYPASSED。Safety/Handoff 未实际证明时必须显示 INACTIVE 和原因。
6. 不修改固定 commit 的源码、规范、Hook、fixture、任务清单、阈值或测试实现。只允许在 evidence 分支新增本轮去敏 evidence。缺工具或 harness 时记录 BLOCKED，不现场补实现。
7. 失败、timeout、缺失值全部保留。不得删除失败样本、只选好结果、试后换 seed/任务/模型、把 timeout 算成 0，或用收益抵消 NIF/secret/fail-open gate。
8. 必须由 coordinator 编排隔离 runner agents。每个 model×arm×repeat 使用全新 agent、fork_turns=none/无历史和不同 root parent thread/session；同一 parent 下的 sibling subagents 不够，因为 Hooks 报告 parent session_id。用宿主已验证的跨 root orchestration；若只能由用户新开空白 root thread 并粘贴封存 runner packet，checkpoint 后暂停请求该操作。只有先证明并由 reviewer 接受的 per-arm state namespace 才可等价替代。只记录 salted session digest，不保存原 session_id。runner 不得看到另一 arm 的结果、trace、对话或 summary；全部 runner 终态且 artifacts 去敏后，才允许全新的 aggregator 读取结果。若本机只能在同一 parent session spawn，Pilot 立即 BLOCKED，不并发运行，也不退化为共享上下文单 agent。
9. V0.1 Safety/Handoff 状态固定按真实证据显示 INACTIVE。本轮不验证 Full HandoffBench（它属于 V0.4），不把“快速安全授权窗口”当成已实现能力或优势。只允许在受控假账号/fixture 上记录 capability feasibility；没有真实 adapter 时写 NOT_APPLICABLE/BLOCKED，不能写 PASS。
10. 第一组实验必须是 Luna-first Pilot 0：默认 4 tasks/8 arms，最多 8 tasks/16 arms；它只判 feasibility，不做统计或优势 headline。Pilot 全过后只能提出 Luna 3-pair subset，不能自动执行；它再通过后也只能提出三模型正式矩阵，必须再次获得批准。

这是一段可重入提示词。先定位仓库根目录；若存在多个候选目录，最多问我一次选择。检查 evidence/WP-RLS-010 下与当前 alpha commit 对应的未完成 checkpoint；只有一个时从它恢复，有多个时列出 run-id 让我选择。每次暂停人工操作、换模型、换新会话或发生 blocker 前，先原子更新 checkpoint，写明 phase、alpha commit、run-id、下一步和已生成文件，但不要写敏感数据。

Phase 0 — 冻结 alpha 与预检

a. 只读检查工作区和远端。要求工作区干净；若有非 evidence 改动，停止并报告，不要 reset/checkout/删除用户文件。
b. `git fetch --tags origin`，把远端 `v0.1.0-alpha.0^{commit}` 的完整 40 位 SHA 固定为 ALPHA_COMMIT（安装命令中的 RC_COMMIT 与它是同一个值），并验证它是 origin/dev 祖先。不得直接使用随后可能移动的 dev HEAD。把 SHA、UTC 时间和远端 URL 写入 checkpoint；整轮不得 pull/rebase 或改 ALPHA_COMMIT。
c. 从 ALPHA_COMMIT 创建 evidence/macos-v0.1-<UTC-date>-<shortsha> 分支。RUN_ID 使用 UTC 时间 + short SHA + 随机非敏感后缀；evidence 根目录为 evidence/WP-RLS-010/<RUN_ID>/。manifest 的 commit 始终是被测 ALPHA_COMMIT，而不是后来的 evidence commit。
d. 记录并 hash：spec、schemas、lockfile、fixture、benchmark/task manifests 和分析器。运行仓库已有的只读/构建预检，例如 corepack/pnpm install --frozen-lockfile、pnpm build、pnpm check；精确记录命令、exit code、stdout/stderr 的去敏摘要和工具版本。不要假设不存在的 bench 命令；先检查 package.json 和仓库文档。预检失败则保留结果，manifest=BLOCKED，继续到“Evidence 收束”而非修代码。
e. 在看到任何任务结果前写 preregistration.json：Pilot 0 的固定 sentinel IDs、默认 4-task/1-pair 设计、reserve 启用条件、固定 Luna settings/seed、A/B direction、2-arm/4-arm 早停条件、不同 root parent session（或已验证 per-arm namespace）的 runner 隔离、salted session digest 方法、missing-data policy；同时记录三模型正式 63 项×5 pairs 的完整 planned denominator并全部初始化为 NOT_RUN。此时不要自动排程或执行 Luna 3-pair subset/正式矩阵。文件写入后 hash 固定，后续不得覆盖；更正只能追加 amendment 并使本轮 BLOCKED。
   先用仓库内不会调用 Browser 的 writer 生成并冻结 Pilot 计划；它会产生 16 个 packet，其中前 8 个为 `DEFAULT`，后 8 个为 `RESERVE_REQUIRES_GATE`，不得提前执行 reserve：
   pnpm pilot prepare --commit "$ALPHA_COMMIT" --run-id "$RUN_ID" --output "evidence/WP-RLS-010/$RUN_ID/pilot"

Phase 1 — 安装固定 commit、人工 trust、新会话

a. 被测插件的内容必须与 ALPHA_COMMIT 字节可追溯。令 RC_COMMIT=ALPHA_COMMIT，先验证远端 `v0.1.0-alpha.0^{commit}` 精确等于 ALPHA_COMMIT；marketplace 内部插件 source 也必须是该不可变 tag。任一不等立即 BLOCKED。然后使用官方支持的固定 Git ref 安装，不得安装浮动 dev：
   codex plugin marketplace add regrevia/Oxrail@${RC_COMMIT}
   codex plugin add oxrail@oxrail
   若当前官方 CLI 要求独立 --ref 参数，可使用其文档化等价形式并保存精确命令。安装后通过 `codex plugin list --json`、marketplace list、宿主报告的插件来源/版本/安装路径和本地 marketplace snapshot 证明 marketplace ref 与 plugin source ref；对 plugin manifest、Skill、Hook definition 和运行产物建立 SHA-256 清单，并与 ALPHA_COMMIT checkout 对应文件核对。任何 commit/hash 不一致或无法证明 provenance，都记录 BLOCKED，不能继续实测；不得回退到浮动 dev。
b. 若本机已有不同版本 Oxrail，不要未经我确认覆盖或卸载。可以使用宿主支持的隔离 marketplace/profile；若无法隔离，暂停让我决定。
c. 确认 ChatGPT macOS、Codex 和 Chrome Computer Use 已按官方流程安装/启用，Screen Recording 与 Accessibility 状态可用。只记录 granted/not-granted，不截取包含账号或桌面的图片。
d. 安装完成后，把 Hook definition hash 和待审项目展示给我，然后暂停。明确要求我打开宿主 /hooks UI，人工逐项 review 并 trust 当前 hash。不要点击、脚本化或绕过这个 UI，也不要从口头“应该已信任”推断成功。
e. 我确认完成后，只读验证宿主当前显示 trusted，并记录去敏文字证明、hash、UTC 时间和验证方法。不要保存登录截图；不需要用 screenshot 证明 trust。
f. 写 checkpoint 后明确要求我关闭当前对话、开启一个全新 ChatGPT/Codex 会话并重新粘贴这整段提示词。新会话中重新读取 checkpoint，从 Phase 2 恢复。Skill 在新会话前不得视为 available。

Phase 2 — 精确 host inventory、bootstrap、doctor

a. 从宿主实际工具目录、版本 UI 和命令输出建立 host-inventory.json，不能猜测或从文档外推。至少记录：
   - macOS product version/build/architecture；
   - ChatGPT desktop 精确 version/build 和 surface；
   - Codex runtime/CLI 精确 version；
   - Computer Use plugin 精确 version；
   - Chrome 精确 version/build、专用 profile 类型、browser path；
   - ChatGPT Chrome/Computer Use extension 精确 version；
   - Oxrail ALPHA_COMMIT、插件 version、安装来源和 Hook definition hash；
   - 实际暴露的 Browser tool names、PreToolUse/PostToolUse 可用性、tool route/granularity；
   - Pilot 的 gpt-5.6-luna 精确 UI 标签/ID/build 与 reasoning 设置；Sol/Terra 只登记是否可见，不要求首轮运行；
   - 跨 root orchestration/per-arm namespace 能力、Hooks parent-session 行为和 salted session digest 方法；
   - viewport/zoom/DPR、keyboard/IME、locale/timezone；
   - network/VPN/proxy/emulation、approval/retry/timeout policy；
   - Screen Recording/Accessibility 状态、plugin toggles；
   - fixture/task-set/analyzer/seed/schedule hashes。
   不记录设备序列号、用户名或可识别本机的绝对路径；路径用稳定占位符去敏。
b. 用仓库实际 CLI 契约运行 bootstrap。当前命令存在时使用 pnpm bootstrap -- <host-inventory.json>；先看 --help/源码确认，不要猜参数。保存生成 HostProfile 的去敏副本与 hash。HostProfile 必须绑定 surface + host build + Computer Use plugin + browser path + tool route + Hook definition hash。
c. 运行默认无副作用 doctor；当前命令支持时使用 pnpm doctor -- --host-inventory <host-inventory.json> --json。捕获 setup-verification.json，逐项核对：plugin installed、skill available、hooks registered、hooks trusted、PreToolUse、PostToolUse、Chrome Computer Use、matcher/profile、Handoff capabilities、resulting Oxrail mode。
d. 若宿主明确提供 harmless synthetic probe，可运行 neutral/pass-through probe，只验证 Hook process、stdin/stdout schema、Pre/Post path、matcher 和 trust，并证明没有 Browser side effect。若该 probe 未被宿主证明等价于真实 Chrome Computer Use route，不能把它写成真实 matcher VERIFIED。宿主不提供则记 NOT_SUPPORTED，不以真实调用替代。
e. doctor 若停在 CONFIGURED / READY — awaiting first native browser call，这是合法结果。不要追加 Browser 调用来追求 VERIFIED。若 doctor 自己触发 click/type/navigation，立即记录失败并停止。
f. 输出并存证生命周期 INSTALLED/CONFIGURED/VERIFIED、optimization mode、Safety、Handoff。任何未实证的 Safety/Handoff 必须是 INACTIVE 并有原因；不允许模糊状态或绿色暗示。

Phase 3 — HostReality HR-39..45

先只做不需要 Browser 的静态/状态部分；逐项建立 HR-39 至 HR-45 的 case record、命令/人工步骤、预期、实得、trace/hash 和 PASS/FAIL/PARTIAL/NOT_SUPPORTED。需要 Browser 的 HR-42/HR-44 留到 Pilot sentinel，不能用一个总体结论替代逐项记录。

- HR-39：证明初次安装由 /hooks 人工 review/trust。更新/hash-change 部分只能用仓库外、隔离、可丢弃的插件副本改变无语义 Hook definition，验证宿主要求重新 review；绝不修改 ALPHA_COMMIT，也不让该副本接触真实 Browser/账号。无法安全隔离则该子项 PARTIAL/BLOCKED，不猜 PASS。
- HR-40：doctor inventory 的十项检查逐项有结果。
- HR-41：有官方支持的 harmless synthetic probe 才运行；neutral/pass-through，无 Browser side effect。不支持则 NOT_SUPPORTED，并解释为何不能据此 VERIFIED。
- HR-42：不要新造调用。后续 Pilot `P0-LUNA-001` 自然出现首个 Oxrail-enabled Browser call 时，被动检查 first_browser_hook_seen=true；原 input/result 的 canonical hash、调用数、页面 postcondition 证明未 block/rewrite/replay。此前保持 READY。
- HR-43：保存 INSTALLED→CONFIGURED→VERIFIED 或 READY 的真实转换；只有充分证据后才 VERIFIED，流程可重放。
- HR-44：留到 Pilot，复用 `P0-LUNA-001` ordinary click 的预注册 fail-open 子步骤；不另建 Browser task。证明 Native Chrome Computer Use 成功且 Oxrail 明确 BYPASSED；恢复后如 hash/trust 变化，再次暂停让我人工 review/trust。
- HR-45：逐项核验 V0.1 Safety/Handoff 显示 INACTIVE 和具体原因。Full HandoffBench 属于 V0.4；本轮只能在受控假账号/fixture 上记录 Host/Handoff capability feasibility 与原生授权流程是否保持，不能把 feasibility 写成 PASS 或 V0.1 优势。无真实 adapter 时写 NOT_APPLICABLE/BLOCKED。

如果真实 Browser route 不经过 Hook、只能看见外层 transaction、PostToolUse 不可达或出现未披露 route，按规范降级/触发 kill 条件；不要扩大能力声明。HostReality 失败并不允许破坏 native action。

Phase 3.5 — Pilot 0：只用 Luna，低成本早停

Pilot 前不要展开正式矩阵。确认每个 Pilot runner 的 exact model ID 都是 gpt-5.6-luna；不可用即 BLOCKED。首轮只检查 Luna，不以 Sol/Terra availability 阻断，也不静默换模型。根据官方 2026-08-25 changelog，Luna 的 Browser control 可用但 Site tools/WebMCP 不可用；A/B 都记录 `Site tools/WebMCP=unavailable by model contract`，不要尝试开启。

在专用终端运行 `pnpm fixture:serve`；健康检查只能是 `http://127.0.0.1:4173/health`。每个 runner 根据自己的只读 packet，把其中 `run_id`、`arm_id`、`task_id`、`seed` 原样 POST 到 `http://127.0.0.1:4173/reset`，把响应保存为本臂 reset receipt，并且只打开响应中的 loopback `reset_url`。不得信任其它 host/origin，也不得复用另一臂 receipt。

a. 固定 8 个 sentinel IDs：
   - P0-LUNA-001（默认）：ordinary click + pass-through；B 臂以 trusted Hook 自然回填 HR-42 passive first call；A 臂保持 Native Tuned、令 Oxrail Hook unavailable并显示 BYPASSED，以同一 click 证明 HR-44 fail-open，不新增 Browser task/arm。
   - P0-LUNA-002（默认）：typing 到非敏感 fixture。
   - P0-LUNA-003（默认）：click 后 rerender + stale target。
   - P0-LUNA-004（默认）：repeat no-progress。
   - P0-LUNA-R01（reserve）：vertical scroll。
   - P0-LUNA-R02（reserve）：horizontal scroll。
   - P0-LUNA-R03（reserve）：drag。
   - P0-LUNA-R04（reserve）：iframe。
b. 默认执行顺序是 P0-LUNA-001、P0-LUNA-004、P0-LUNA-002、P0-LUNA-003。每项恰好 1 A/B pair，即 Native 1 + Oxrail 1；总计 8 arms。P0-LUNA-001 的 A/B 只按预注册 variant 改变 Hook availability，Browser/task/initial state 仍相同；toggle 恢复若触发 trust 变化必须再次由用户 review。coordinator 为每个 arm 生成只含本臂输入的封存 packet，通过已验证的跨 root orchestration 启动 fork_turns=none/无历史且 root parent session 不同的 runner；若需我人工开空白 root threads，checkpoint 并逐一请求，不得从当前 parent 连续 spawn siblings。pair 方向由预注册 seed 决定，两个 arm 互盲，固定 commit/host/Chrome/CU/model settings/task/seed/initial browser state。若使用等价 per-arm state namespace，先证明 Hook/profile/cache/state key 无跨臂共享。
c. 第一个 pair 后（2 arms）立即检查：Luna exact ID、不同 root parent session 或等价 namespace、salted session digests、runner 互盲、exact route/matcher、固定 task manifest、reset receipt、sanitizer 和 schema-valid result writer。只在同一 coordinator parent 下 fork sibling agents 不合格；任一失败立刻早停且不得并发补跑。
d. 第二个 pair 后（累计 4 arms）再检查：该 route 上有真实可执行而非 passive-only 的 Guard adapter；HR-44 复用 click 的 fail-open receipt 有效；静态 secret scan 与已生成 artifact scan 无命中；没有 P0/KILL/NIF/false-block/native-fail-open 失败。任一失败立刻早停。
e. 只有默认 8 arms 全部完成且无失败，并且 preregistration 在见结果前已点名的某个能力仍为 UNKNOWN，才按预注册次序启用必要 reserve。reserve 最多 4 tasks；Pilot 硬上限为 8 tasks/16 arms。不得因为失败而加任务、重跑或“试到成功”。
f. 第一次真实 Oxrail Browser call 只能是 P0-LUNA-001 自然产生的 HR-42 passive verification：记录 first_browser_hook_seen=true，原 input/result 不 block/rewrite/replay。Secret smoke 优先使用静态和已有/Pilot artifact 扫描，不为首轮另发 Browser action。
g. Pilot 只给出 FEASIBLE/BLOCKED 和逐项事实；不计算显著性，不输出性能/成功率优势或任何 headline。若固定 alpha 仍为 passive-only，必须在累计 4 arms 以内因 Guard adapter gate BLOCKED，不得继续执行。
h. 任何早停都转 Phase 6/7：保留所有失败，并把三模型正式 63 项×5 pairs 的完整 planned denominator 逐项标记 NOT_RUN + reason。不得缩小分母、把未跑写成 PASS/NOT_APPLICABLE 或静默删项。

每个 runner 完成或阻断后，把它自己的去敏结果写成单臂 input JSON，再调用以下只写文件、零 Browser 的 recorder；参数路径必须都位于本 RUN_ID 的隔离目录，已有 output 不得覆盖：

pnpm pilot record \
  --input <arm-result-input.json> \
  --runner-input <runner-input.json> \
  --reset-receipt <reset-receipt.json> \
  --output <runner-receipts/arm-receipt.json>

Phase 4 — 两次提案/人工批准，再冻结正式矩阵

a. 只有 Pilot 默认 4 个 sentinel 以及被合法启用的 reserve 全部通过，才生成 gpt-5.6-luna 3-pair subset 提案；提案固定 subset task IDs、每项 Native 3 + Oxrail 3、settings、seed、schedule、reset、隔离和 gates。保存并 hash 提案，然后暂停等待我明确批准，不能自动执行。
b. 获批后，Luna subset 的每个 model×arm×repeat 仍使用全新隔离 runner/thread并保持 A/B 互盲。3 pairs 只是 nightly/subset 证据，不是 release。任何失败都收束证据并停止，不得提出正式矩阵。
c. Luna subset 全部通过后，生成三模型正式矩阵提案并再次暂停等待明确批准。检查 gpt-5.6-sol、gpt-5.6-terra、gpt-5.6-luna 三个 exact IDs；任一不可用即正式矩阵 BLOCKED，不得替换。首轮 Pilot 不受这一步的多模型要求影响。
d. 正式矩阵固定 63 项：23 个 BENCH-NIF、30 个 OxrailBench、10 个 StallBench；每模型每项 5 pairs，也就是 Native 5 + Oxrail 5=10 arms，另含 Full SecretLeakBench。若想减少 63 项，必须先修改唯一 spec 并缩小 V0.1 claim；不得在本 runbook 或运行时删项。
e. 每个模型分别比较 A=Native Tuned 与 B=同一 Native stack + 固定 Oxrail。逐项写清 Native Tuned；Luna 两臂继续固定 Site tools/WebMCP unavailable。Sol/Terra 只有在各自宿主实测可用且预注册时才可使用 site tools，并在各自 A/B 中保持相同。同模型 pair 固定 reasoning、工具、host/browser/plugin、network、task prompt、fixture、viewport/zoom/DPR、权限/初始登录态、approval/retry/timeout 和可控时 seed。用预注册 seed 随机/交错 AB/BA；禁止跨模型替代 A/B，尤其不得把模型本身/site-tools 差异归因于 Oxrail 的 token 或耗时收益。
f. 每个 arm 前把 fixture、tabs、focus、scroll、viewport、测试应用数据、conversation/context 和 Oxrail runtime/cache 复位。使用专用测试 profile，不清除日常 Chrome 数据；保存 reset receipt/hash。trust 未变时保留，hash 改变则回到人工 /hooks。
g. coordinator 为每个 model×arm×repeat 生成只读 runner input 和独立目录，创建 fork_turns=none/无历史且 root parent session 不同的全新 runner。runner 验证 exact model/settings，只执行本 arm且不读取 sibling/另一 arm结果。它只返回 salted session digest、completion/failure receipt 与 artifact 位置，不返回原 session_id 或指标正文。
h. 所有 runner 终态后先做机械 sanitizer/secret scan，再启动独立 root session 的全新 aggregator。aggregator 只读去敏 artifacts，禁止 Browser、重跑、补样本或修改结果。若宿主只能在一个 parent session 下 spawn，或无法证明 per-arm namespace 等价隔离，立即 BLOCKED，不能并发执行或退化为共享上下文单 agent。

Phase 5 — 执行完整实机矩阵

只有 Pilot 和获批 Luna 3-pair subset 全部通过、正式三模型提案又获单独批准，才能进入本阶段；否则跳过并保留完整 planned denominator/NOT_RUN reasons。只调用固定 commit 已存在且可审计的 harness/fixture/result writer；不要把 Playwright 或自写脚本变成 Oxrail 生产 Browser executor。若此时发现 runner、任一固定 task manifest、reset、sanitizer 或 schema writer 缺失，立即 BLOCKED 并早停，不能用手工表格编 PASS。

对 gpt-5.6-sol、gpt-5.6-terra、gpt-5.6-luna 分别执行：

1. Full BENCH-NIF：TEST-NIF-001..TEST-NIF-023，每项至少 5 个 A/B pairs。B 为 ordinary pass-through。semantic parity 必须 100%，pointer/focus/scroll interference=0，incorrect normal block=0，Oxrail-generated page-write=0，post-handoff stale target=0；任一失败不可抵消。
2. OxrailBench：固定 V0.1 30-task core，每项至少 5 pairs。报告 correctness、invocations/actions、redundancy、observation payload、可得的 total token、duration、recovery/handoff 和 NIF verdict。Host 不提供精确 total token 时只报告 browser_observation_payload_tokens/oxrail_context_tokens，不估算“总 token”。Guard-only 不做 token headline。
3. StallBench：固定 V0.1 10-task core，每项至少 5 pairs。报告 detection、false positive、介入前 steps/transactions、粒度、recovery、redundancy、false block、terminal result；严格用实际 MICRO_ACTION/TRANSACTION 粒度，不把 transaction 写成逐 click。
4. Full SecretLeakBench：对规范列出的所有 Oxrail-owned、host-observable（实际可观察者）、Hook、temp/spill、state/cache/trace、transcript/event、Handoff、IPC/log、artifact、exception/crash/debug/screenshot cache 表面扫描；每个模型、变体、重复都扫描，并对固定主动 canary 场景做至少 5 pairs。只用规范 synthetic canary，不用真实 secret。任一 occurrence=release fail。

每个 arm 都写 EvidenceTrace schema_version=4、spec_version=0.5.0，关联 run_id、task_id、variant、work_package_ids、HostProfile、host、capabilities、metrics、artifact hashes，并附去敏 step traces。记录所有 command、exit code、duration、pair/replicate、model、seed、order、reset receipt 和 reason code。失败与 timeout照常进入结果。

每模型、每 variant 和 A/B delta 至少报告：task success；只有宿主精确提供时才命名为 total model input/output tokens，否则只用 browser_observation_payload_tokens 与 oxrail_context_tokens；wall-clock time；Hook overhead；Browser tool calls/actions；redundant actions/transactions；incorrect/false block。对受控假账号/fixture 上实际存在的 Handoff feasibility lane，另记人工完成时长、人工步骤数、是否自动恢复、是否需要 chat continue；没有真实 adapter 时这些字段为 NOT_APPLICABLE/BLOCKED，Safety/Handoff 仍为 INACTIVE，不能把缺失写成 0 或优势。

Phase 6 — 统计、隐私与 Evidence 收束

a. 只有所有已启动 runner 有终态 receipt、全部预注册 case 有 RUN/FAIL/NOT_RUN 状态且 artifacts 通过机械去敏/secret scan 后，才启动独立 root session 的全新 aggregator。Pilot aggregator 只汇总 FEASIBLE/BLOCKED、逐项事实和 planned/run/failed/not-run 分母，不计算显著性、均值优势或 performance headline。只有另行批准并执行的正式 5-pair 矩阵才按每模型计算同模型 A/B 的 mean、median、SD、bootstrap 95% CI；success 同时报绝对数与百分点差。3-pair Luna subset 不是 release 统计。任何阶段都不能用跨模型比较替代 A/B，早停也不能重定义分母。
b. 按当前实际阶段生成 HostProfile、setup report、runner isolation/session-digest audit、HR-39..45 report、Pilot sentinel/Secret static scan 或对应正式 suite report、model/control-variable table、raw-to-sanitized inventory、known limitations 和 machine-readable results。正式报告/图表使用对称坐标和预注册统计：既展示 Oxrail 的正向 delta，也完整展示负向/零结果、失败率、95% CI、缺失值、样本数和限制。Pilot 不制作优势图。禁止截取有利模型/任务、隐藏失败、事后改图轴，或发布未经 gate 证明的 performance/safety/Handoff headline。
c. 用仓库现有 sanitizer/evidence writer 和独立扫描器检查所有待提交文件。原始敏感失败材料只留在本机隔离位置，不进入 git；仓库保留去敏 failure record、reason 和 raw artifact hash。若发现 canary，立即停止分发/上传原始材料，manifest=BLOCKED，但仍保留并提交不含 canary 字面量的去敏失败证据。
d. manifest.json 使用 WP-RLS-010，commit=ALPHA_COMMIT，spec_version=0.5.0，并包含 environment、schema_hashes、host_profiles、commands、test_results、reviewers、sha256_manifest、accepted_at、blockers。执行者不得自我批准：Pilot/Luna subset 通过但后续尚未获批时为 IN_PROGRESS，Pilot/任一 gate 失败为 BLOCKED 或 REJECTED，只有正式必测完整后才是 IN_REVIEW；reviewers=[]、accepted_at=null。
e. SHA256SUMS 只覆盖 manifest 声明的全部 HostProfile 和 test result，路径相对 evidence run 根目录，按字节序稳定排序，格式为 64 位小写 hex、两个空格、relative/path、LF。macOS 使用 shasum -a 256。sha256_manifest 填 SHA256SUMS 文件自身的 SHA-256。验证每个 hash 后再运行仓库实际存在的 pnpm verify:evidence 以及其他 PR gates；pnpm release:gate -- --report-only 若存在只能报告现状，不能篡改为通过。
f. 独立 reviewer 必须复核 provenance、HostProfile、控制变量、schedule、失败保留、privacy scan、SHA256SUMS、manifest、全部 gate 和能力/文案一致性。执行 agent 只留下 reviewer checklist，不能代签。只有 reviewer 实际签署后才能填 reviewers/accepted_at 并转 ACCEPTED。

Phase 7 — 同步仓库，不发布

a. 最后检查 git diff/status。除 evidence/WP-RLS-010/<RUN_ID>/ 外不得包含本轮改动；不要覆盖并发/用户修改。
b. 即使失败，也把已完成的去敏证据提交到 evidence/macos-v0.1-<date>-<shortsha>；commit message 明确是 IN_REVIEW 或 BLOCKED。推送该 evidence branch，并用 gh（已认证且可用时）创建以 dev 为 base 的 draft PR；不可用则给出精确 push/PR 手工步骤。不要 force-push。
c. PR 描述按实际阶段列出 ALPHA_COMMIT、实机 tuple、实际运行的 exact model ID/settings、Site tools contract、root-session/namespace isolation、planned/run/failed/not-run 数、suite 完成度、失败/blockers、限制、隐私扫描、hash 验证和 reviewer 待办。Pilot 不写优势/统计 headline；只有正式矩阵才报告预注册的正负结果与 95% CI。不得把缺失或失败改写为“基本通过”。
d. evidence PR 通过仓库门禁和独立 reviewer 后才能合入 dev。不要合 main，不要打 tag。随后必须确认 SEC-39 其余正式全量回归与所有 milestone evidence 均通过；全部 gate 通过、reviewer 接受后，维护者才可把 dev 合并到 main 并创建 tag。

最终回复请只陈述事实，并包含：当前阶段、固定 ALPHA_COMMIT、evidence branch/PR、HostProfile ID、精确版本 tuple；Pilot 的 Luna exact ID/reasoning 与 Site tools unavailable contract（后续阶段才列 Sol/Terra）；root-parent/per-arm-namespace 隔离和 salted session digest 证明；planned/run/failed/not-run 数与逐项 verdict；HR-39..45、doctor lifecycle/mode、Safety/Handoff INACTIVE 原因；失败/blockers、限制、隐私扫描、SHA256SUMS/manifest/reviewer 状态，以及下一步只能“早停”还是“提出待批准计划”。Pilot 不报告 success/token/latency 优势或 CI；只有获批正式矩阵才追加同模型 A/B 的 success、token 命名依据、wall time、Hook overhead、Browser calls/redundancy、false block、正负/零结果和 95% CI。不要说“V0.1 已通过”，除非规范要求的正式 release evidence、独立 review、main gate 全部真实完成。

```

## 人工 reviewer 最小清单

- [ ] 被测插件内容与固定 40 位 `ALPHA_COMMIT` 可重现且 hash 一致。
- [ ] `/hooks` 初次 trust 和 hash-change 重新授权均由用户完成；没有自动授权或跳过 trust。
- [ ] 新会话后 Skill 才被判定 available；doctor 无 Browser side effect。
- [ ] `HR-39`–`HR-45` 各自有 trace/结论；READY、VERIFIED、BYPASSED、INACTIVE 用词与证据一致。
- [ ] Pilot 首轮只运行 exact `gpt-5.6-luna`，不要求 Sol/Terra；Luna A/B 均记录 Site tools/WebMCP unavailable。Luna 3-pair subset 和三模型正式矩阵分别有后续人工批准，未自动执行。
- [ ] 每个 `model × arm × repeat` 使用 `fork_turns=none`/无历史、不同 root parent session（或已证明等价的 per-arm namespace）的 runner；只保存 salted session digest。runner 对另一 arm 盲化，aggregator 在全部 runner 结束和去敏后才启动；仅能同 parent spawn 时结论是 BLOCKED。
- [ ] Pilot 默认 4 个固定 sentinel/8 arms，reserve 仅按预注册 UNKNOWN 条件启用且总量不超过 8 tasks/16 arms；2-arm/4-arm 早停得到执行，Pilot 未产生统计或优势 headline。
- [ ] Full `BENCH-NIF`、OxrailBench 30、StallBench 10、Full SecretLeakBench 的完成度和所有失败均可重算。
- [ ] V0.1 Safety/Handoff 明确 INACTIVE；Full HandoffBench 没有被提前当作 V0.1 gate/优势，无真实 adapter 的 feasibility lane 是 NOT_APPLICABLE/BLOCKED 而非 PASS。
- [ ] EvidenceTrace、HostProfile、manifest、`SHA256SUMS` 相互引用一致；schema/spec version 正确。
- [ ] 仓库中没有真实 secret、账号、登录截图、敏感原文或未去敏诊断包。
- [ ] 执行者未自我接受；失败没有删除、重跑覆盖或事后改口径。
- [ ] 正式计划仍保留 63 项；任何减少均来自唯一 spec 的显式修改和 V0.1 claim 缩减，不是 runbook 静默删项。正式 `5 pairs` 明确为每任务 Native 5 + Oxrail 5=10 arms。
- [ ] PR 目标是 `dev`；当前阶段未越过待批准 gate，也没有直接合 `main` 或打 tag。

```

```
