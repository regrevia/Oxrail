# WP-LAB-001 交付

WP: WP-LAB-001

Base commit: `7eeee69`（WP-LAB-000 接入当前 `dev`）

Result commit: 使用 `git log -- docs/lab-wp-001-delivery.md` 查询本文件所属提交。

Status: IN_REVIEW

Changed files: 产品/Lab 构建入口、产品白名单与打包器、依赖和安装产物验证器、staged plugin 验证、产品用户文档、根命令、CI 可用测试与生成产物。

What works now: `pnpm build` 只生成 bootstrap、doctor 和产品 Hook；evidence、pilot、release gate 和 Handoff probe 只由 `build:lab` 生成。`release/oxrail` 从显式白名单构造，并带实际 esbuild 输入依赖清单。复制后的安装根无需源码或 Lab 即可运行 doctor，且能力状态保持诚实。

Commands actually run + exit codes:

- `pnpm test:product`: 0，2 tests passed。
- `pnpm package:product`: 0。
- `pnpm validate:boundaries`: 0。
- `pnpm validate:product-artifact`: 0。
- `node scripts/validate-plugin.mjs --root release/oxrail`: 0。
- `pnpm validate:plugin`: 0。
- `pnpm check`: 1；format、lint、typecheck 通过，477 tests 中 476 passed / 1 failed。失败为既有并发用例 `credential admission > keeps an incoming Pre behind the combined preparation` 本次得到 `UNKNOWN` 而非 `BLOCKED`。
- 对上述失败用例单独重跑：0，1 passed / 14 skipped；记录为非确定性基线问题，不把单次重跑替代全量 check。
- `pnpm release:gate`: 1；明确 BLOCKED，因为当前 Linux 开发宿主没有真实 ChatGPT Desktop Chrome 路由、NIF 与 V0.1 接受证据。

Tests not run + reason: macOS Swift、实际插件安装器、真实 Chrome、ChatGPT Desktop 和四象限未运行；当前为 Linux 云端环境，且没有宿主 Computer Use 路由。真实安装器能否从专用不可变发布 ref 只取得白名单树仍需后续发布工作验证。

Real-host evidence: absent。

Capability status and coverage: 产品仍为 passive-only；Optimization 为 BYPASSED，Safety/Handoff/Credential 为 INACTIVE。构建隔离测试不提升任何宿主能力声明。

Artifact dependency / privacy check: 产品 esbuild 依赖图不包含 `lab/**`、`benchmarks/**`、`packages/evidence/**` 或 `packages/native-fidelity/**`；安装根没有 Lab、Demo、pilot、evidence、benchmark 或测试入口，也不创建 `~/.oxrail-lab`。

Known blockers: 正式 GitHub marketplace 仍引用历史整仓 tag；需要在发布任务中创建只含产品安装根的不可变发布树/ref并进行真实安装。全量测试存在一次既有并发不稳定结果。真实宿主与 macOS 证据缺失。

Next eligible WP: WP-LAB-002，迁移 evidence、credential fixture、probe 与 native Demo 到独立 Lab；宿主阻断不妨碍该源码迁移。
