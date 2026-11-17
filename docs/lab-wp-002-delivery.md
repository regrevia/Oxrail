# WP-LAB-002 交付

WP: WP-LAB-002

Base commit: `cd1f497`（WP-LAB-001）

Result commit: 使用 `git log -- docs/lab-wp-002-delivery.md` 查询本文件所属提交。

Status: IN_REVIEW

Changed files: `lab/` 独立包、evidence/pilot/release gate、Handoff probe、credential fixture 脚本、macOS Demo/Keychain probe、Lab 测试和配置；产品 Skill/README、产品 Swift Package、workspace/build/clean/CI 命令。

What works now: 产品源码与默认测试不再包含 evidence、pilot、probe 或 credential Demo 入口。Lab 使用独立构建目录和测试配置；credential Demo 的 Swift scratch root 为 `~/.oxrail-lab`。产品 macOS package 只保留 CodeIdentity、CredentialRegistry 与 CredentialEnclave 库；Demo 和 Keychain probe 的 executable/测试目标属于 `lab/native/macos`。旧 `~/.oxrail/credential-demo` 只可通过显式限域命令检查或清理。

Commands actually run + exit codes:

- `pnpm typecheck`: 0。
- `pnpm test:lab`: 0，7 files / 34 tests passed。
- `pnpm package:product`: 0。
- `pnpm validate:boundaries`: 0。
- `pnpm validate:product-artifact`: 0。
- staged/source plugin validation: 0。
- `pnpm check`: 0；产品 25 files / 444 tests 与 Lab 7 files / 34 tests 全部通过，format/lint/typecheck、产品打包/边界、plugin/spec/evidence/secret 检查全部通过。
- `pnpm release:gate`: 1；按规范因真实 ChatGPT Desktop Chrome、NIF 与已接受 `WP-RLS-010` 证据缺失而明确 BLOCKED。

Tests not run + reason: `swift test`、真实 macOS native prompt/Keychain、实际 ChatGPT Desktop/Chrome、真实插件安装器与四象限未运行；当前 Linux 云端没有 Swift、AppKit、macOS Keychain 或 Host Computer Use 路由。

Real-host evidence: absent。

Capability status and coverage: 产品保持 passive-only；Optimization BYPASSED，Safety/Handoff/Credential INACTIVE。迁移后的 native credential 项仍仅是 fixture，不能申请或复用真实凭据。

Artifact dependency / privacy check: 产品白名单不含 `lab/` 或 native fixture executable。Lab fixture 继续拒绝 argv secret，输出仅固定状态/opaque reference；旧缓存清理测试证明产品 runtime-state 不受影响，命令不扫描或删除 Keychain。

Known blockers: macOS Swift 验证依赖 macOS runner；真实 ChatGPT Desktop Chrome route、Host-wide suspension、same-tab Handoff 和 credential enclave 签名/消费链仍缺失。Marketplace 专用不可变产品 ref 的实际安装验证仍属于发布工作。

Next eligible WP: WP-LAB-003，建立严格 SafeEvent 协议与不依赖产品的本地采集器；之后才可做 `codex-local-hook-v1` 真实适配。
