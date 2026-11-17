# WP-LAB-000 交付

WP: WP-LAB-000

Base commit: 900793b（原 dev 6dbf338f666f77eefed5a7df76979c8e8b12d6a7 的既有工作区快照）

Result commit: 本文件所属的 WP-LAB-000 独立提交，使用 git log -- docs/lab-wp-000-delivery.md 查询。

Status: IN_REVIEW

Changed files: canonical spec、镜像、两个checksum、两个机器索引、索引生成器、CHANGELOG、ADR-LAB-001、lab-state-inventory、lab-baseline、本交付记录。

What works now: 合同原文已并入SEC-51；保留历史ID，新增8个工作包与20个测试的索引；现有落盘字段组均明确产品保留或Lab迁移目标。没有改动浏览器运行行为。

Commands actually run + exit codes:

- pnpm test（迁移前基线）：1，528 passed / 2 skipped / 1 failed。
- node scripts/generate-spec-index.mjs：0。
- pnpm validate:spec：0，版本1.0.24，镜像、索引、SHA一致。
- git diff --check：初次2（合同两行末尾空格），修正后0。
- pnpm check：1；format、lint、typecheck通过；test仍为528 passed / 2 skipped / 1 failed，evidence-gate完整矩阵30秒超时，与基线一致。后续链式检查没有由该命令执行。

Tests not run + reason: 真实Chrome、Lab-only、四象限、宿主权限隔离与凭据交接未跑；本包是文档冻结，没有独立Lab或真实适配器可验收。release:gate未跑：本包无发布产物变更，发布检查由WP-LAB-001执行。2个既有skip不计PASS。

Real-host evidence: absent。手工投递Hook的既有冒烟不能替代真实宿主路径验证。

Capability status and coverage: 产品仍为被动适配；Guard/Handoff/Credential未激活，本包没有能力提升声明。

Artifact dependency / privacy check: 字段清单明确安全锁、租约、pending调用、恢复幂等及近期能力标记保留；实验记录器和凭据Demo必须移出产品。当前混合构建尚未隔离。

Known blockers: 既有evidence-gate超时使全量check不通过；真实宿主接口及执行Agent对Lab报告的访问隔离尚未实证。当前开发任务拥有文件全访问权，不能作为正式隔离baseline。

Next eligible WP: WP-LAB-001，实施产品白名单构建、依赖图检查和安装根测试；随后WP-LAB-002内部迁移。上述宿主阻断不阻止清包开发。
