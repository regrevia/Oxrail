# WP-LAB-003 交付

WP: WP-LAB-003

Base commit: `7ab6d00`（WP-LAB-002）

Result commit: 使用 `git log -- docs/lab-wp-003-delivery.md` 查询本文件所属提交。

Status: IN_REVIEW

Changed files: `lab/protocol/` SafeEvent/Metric schema、`lab/monitor/` collector 与 authenticated local IPC、Lab build dependency manifest、边界验证及 39 项 Lab 测试。

What works now: Lab collector 只接受严格 SafeEvent，拒绝未知字段、任意 metric key、自由文本逃生字段、错误质量组合和超限 frame；offer 在入队后立即返回，不等待磁盘。事件 ID 幂等、乱序不伪造结果，队列/磁盘故障标记 incomplete。Unix socket 使用每次启动的独立 32-byte session token，私有目录/文件权限，固定中性响应。默认保留期清理只处理 Lab `runs/` 下的真实过期目录且不跟随 symlink。

Commands actually run + exit codes:

- collector 窄测：0，5 tests passed。
- `pnpm test:lab`: 0，8 files / 39 tests passed。
- `pnpm validate:boundaries`: 0；产品和 Lab monitor 两类依赖边界通过。
- `pnpm check`: 0；产品 25 files / 444 tests、Lab 8 files / 39 tests 全部通过，静态、打包、spec、evidence 与 secret 检查全部通过。

Tests not run + reason: 真实宿主 Hook/trace、collector kill 下的真实浏览器动作、macOS、ChatGPT Desktop/Chrome 与跨用户 sandbox 未运行；当前 Linux 云端没有相应宿主路径。本包测试只证明受控事件和本地 IPC，不证明宿主覆盖率。

Real-host evidence: absent。

Capability status and coverage: SafeEvent source 目前只有受控 fixture 测试；`codex-local-hook-v1` 尚未接线，真实 coverage/granularity 为 UNKNOWN。产品仍 passive-only/BYPASSED，Safety/Handoff/Credential INACTIVE。

Artifact dependency / privacy check: Lab monitor dependency manifest不含产品 Hook、Core、Host adapter 或 Handoff extension。秘密诱饵位于未知字段、超限 frame 与 writer error 时均未进入 trace；IPC 响应不含 allow/deny、模型上下文或输入输出。

Known blockers: 真实 Codex Hook inventory/schema、Host session/actor 标识、真实 Pre/Post 覆盖与 neutral response 合同需在具体宿主验证。操作员数据对执行 Agent 的正式权限隔离仍未证明。

Next eligible WP: WP-LAB-004，基于精确 inventory 建立独立 `codex-local-hook-v1` adapter 和 Lab Hook 安装根；无真实宿主时实现可验证的 fixture 路径并将真实验收保持 BLOCKED。
