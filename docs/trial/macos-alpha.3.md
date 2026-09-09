# Oxrail alpha.3 macOS 本机试用

本文只验证 `product-v0.1.0-alpha.3` 的产品安装完整性、Hook 被动路由和
Native Chrome 故障开放行为。它不是 Guard、页面检索过滤、Handoff 或安全凭据
窗口的通过报告；这些能力在本版必须继续显示 `BYPASSED` 或 `INACTIVE`。

## 1. 准备隔离环境

- 使用 Node.js 20 或更新版本、当前 Codex CLI、ChatGPT macOS 桌面应用、
  Chrome Computer Use 扩展。
- 新建专用 Chrome profile；关闭密码管理器、同步和其它扩展。
- 只访问公开页面或本地 fixture，不登录，不输入真实密码、OTP、Cookie、Token
  或支付数据。
- 记录 macOS、ChatGPT、Codex、Chrome、Computer Use 扩展的精确版本。

## 2. 从 dev 市场安装产品树

```bash
codex plugin marketplace add regrevia/Oxrail@dev
codex plugin add oxrail@oxrail
```

若本机已有同名 marketplace/plugin，先使用当前 Codex CLI 提供的列表和更新命令
确认实际 ref 已变为 `product-v0.1.0-alpha.3`；不要猜测本机缓存目录并手工覆盖。
安装或更新后开启全新会话。

## 3. 零浏览器预检

在新会话中发送：

```text
使用 Oxrail，运行它自带的 trial-check.mjs，并完整返回 JSON；不要访问浏览器。
```

预期：

- `version` 为 `0.1.0-alpha.3`；
- `artifactIntegrity` 为 `PASS`；
- 初次通常为 `HOST_SETUP_REQUIRED`；
- Optimization 为 `BYPASSED`；Safety、Handoff、Credential 均为 `INACTIVE`；
- 命令不打开 Chrome、不弹系统窗口、不创建 `~/.oxrail-lab`。

任何文件 hash 失败、版本不符或能力错误显示 `ACTIVE` 都应立即停止并记录 FAIL。

## 4. 人工信任与真实 inventory

1. 在宿主 `/hooks` 打开 Oxrail 定义，核对命令只指向当前插件根中的
   `dist/hooks/pre-tool.mjs` 和 `post-tool.mjs`，且 build stamp 为
   `0.1.0-alpha.3`。
2. 由你本人通过宿主 UI 信任当前 hash。Oxrail 不得替你操作或绕过此步骤。
3. 如果宿主能导出当前工具 inventory，按 Skill 所示 strict JSON 保存；其中
   Browser tool name 必须来自真实导出。运行 bootstrap 后再次运行 doctor。
4. 如果宿主没有可靠 inventory 导出能力，不要编造名字：记录
   `BLOCKED: HOST_INVENTORY_UNAVAILABLE`，仍可继续测试原生故障开放，但不能把
   Oxrail route 标成 VERIFIED。

## 5. 被动真实路由 smoke

在同一个可见 Chrome tab 打开一个公开、无登录页面，然后给 Agent 一个本来就
需要的只读任务，例如“读取页面标题并返回”。不要为了测试额外制造 click/type。
任务后立刻再次运行 `trial-check.mjs`，保存两次去敏 JSON 和 `/hooks` 中显示的
当前 hash。

通过条件：原生动作只执行一次；页面/tab 没有被 Oxrail 复制、隐藏或关闭；输入
与结果没有被 Hook 改写；若宿主确实向这两个 Hook 投递了匹配事件，doctor 可记录
被动 route observation。即使如此，本版 resulting mode 仍只能是
`ADVISORY_ONLY`，Optimization 仍为 `BYPASSED`。

## 6. 故障开放 smoke

只通过宿主 UI 临时禁用或取消信任 Oxrail Hook，再在公开页面执行一次等价只读
任务。预期原生 Chrome 任务仍成功，Oxrail 明确显示 `BYPASSED`，三项保护仍为
`INACTIVE`。随后恢复 Hook；如 hash/trust 改变，重新人工 review，不沿用旧结论。

## 7. 结果记录

建立一个本机文本表，逐项记录 `PASS / FAIL / BLOCKED`：安装 hash、人工 Hook
trust、新会话 Skill 加载、inventory 来源、首次自然 Browser 调用、单次原生动作、
同 tab 保持、故障开放、状态如实显示。只保存版本、时间、固定 reason code 和上面
两份 doctor JSON；不保存页面正文、完整 URL query、截图、工具原始输入输出、
session ID 或任何秘密。

若页面检索过滤、快速凭据窗口或自动 Handoff 没有出现，这是 alpha.3 的预期，
记录 `BLOCKED_NOT_PRODUCT_ACTIVE`，不要把宿主自己的登录框或批准弹窗计为 Oxrail
能力。把去敏结果和精确版本信息反馈到 `dev`，后续才能据此推进真实适配。
