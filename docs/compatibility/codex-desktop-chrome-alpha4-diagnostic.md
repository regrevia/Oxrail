# Codex Desktop + Chrome alpha.4 宿主诊断

日期：2026-09-09

产品基线：`b3f2285101284f8e604a3e07e1278c03017f6029`

状态：`BLOCKED`，不是 Host Profile 或能力通过报告

## 收到的真实宿主事实

- 产品完整性：`PASS`
- lifecycle/readiness：`INSTALLED / HOST_SETUP_REQUIRED`
- Hook build stamp：`0.1.0-alpha.4`
- 宿主 `/hooks` 中已由用户人工 review + trust
- 用户报告的 Hook definition hash：
  `03a6aca86564d2004b33400e2e320135e3e9645ef776c2f6df2a31ab42788819`
- 基线源码重新构建得到相同 hash；因此本次不能归因为旧安装或旧 Hook hash
- 未观察到真实 Hook 执行事件
- 宿主没有提供可验证的 Computer Use tool inventory
- Chrome smoke 没有成功产生 Browser 动作，页面和 tab 未改变
- Optimization/Mode：`BYPASSED / UNSUPPORTED`
- Safety/Handoff/Credential：`INACTIVE`

没有记录页面正文、URL query、截图、原始 tool input/output、session ID 或秘密。

## 官方合同结论

OpenAI 的 [Hooks 文档](https://learn.chatgpt.com/docs/hooks) 说明：

- 非托管插件 Hook 的 trust 绑定 exact definition hash，`/hooks` 是人工 review、
  trust 和禁用入口；
- 插件 Hook 获得 `PLUGIN_ROOT` 和 `PLUGIN_DATA`；
- `PreToolUse` / `PostToolUse` 覆盖 shell、`apply_patch`、MCP 和多数 local
  function tools；
- hosted tools 不进入这条 Hook path，某些 specialized tool paths 可以绕过默认
  Hook path，因此 Hooks 不能视为完整 enforcement boundary。

OpenAI 的 [Browser extension 文档](https://learn.chatgpt.com/docs/chrome-extension)
要求在 ChatGPT Desktop 的新 ChatGPT Work 或 Codex chat 中通过 `@` mention
选择 Chrome 和正确 profile/tab。该公开文档没有提供 Hook trust 查询 API，也没有
提供 Computer Use tool inventory 导出接口。

## 根因与未决分支

已确认的产品诊断缺陷：alpha.4 把“最近 Hook 执行证据不存在”压缩为
`hooksTrusted=false`。这不能判断 `/hooks` 中的实际 trust 状态，也混淆了以下分支：

1. 插件 Hook 没有加载进当前会话；
2. Hook 已加载，但当前操作没有进入受支持的 local/MCP tool path；
3. Chrome 没有通过新 Codex chat 的 `@Chrome` 路由启动；
4. Chrome Computer Use 属于绕过默认 Hooks 的 specialized path；
5. Hook 执行后无法写入 `PLUGIN_DATA`。

当前证据只足以排除旧 hash，不能区分上述 1、2、3、4、5。由于 smoke 没有产生
Browser 动作，也不能把“Chrome 路由不触发 Hook”判为已证明。

## 处置

alpha.5 doctor 将分别报告：

- `hookTrustAuthority=HOST_UI`
- `hookTrustQuery=UNAVAILABLE_PUBLIC_API`
- `hookExecution=NOT_OBSERVED|OBSERVED_CURRENT_DEFINITION`
- `toolInventoryExport=UNAVAILABLE_PUBLIC_API`
- `inventoryStatus=BLOCKED|PROVIDED_AND_VALIDATED`
- `chromeRoute=BLOCKED|NOT_OBSERVED|OBSERVED_PASSIVE`
- 固定 blocker codes，不猜测工具名

在 alpha.5 实机复验前，`WP-HOST-003`、`GATE-G1`、HR-01/02/42/44 以及
`WP-LAB-004` 真实宿主部分保持 `BLOCKED`。若本地工具 Hook 可观察、而正确
`@Chrome` 路由仍不可观察，则按 `KILL-K1/KILL-K3` 将该具体 Host tuple 保持
`ADVISORY_ONLY/UNSUPPORTED`，不继续透明中间层或安全 enforcement 声明。
