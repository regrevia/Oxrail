# Oxrail 云端开发交接

日期：2026-09-09
交接分支：`codex/lab-separation`
交接基线：`c006a36`（WP-LAB-000 独立提交）
原始开发基线：`dev` / `6dbf338f666f77eefed5a7df76979c8e8b12d6a7`

## 当前结论

当前版本**不能宣称真实可用**。`BYPASSED` 表示 Native Computer Use 没有经过可验证的 Oxrail 宿主适配，不是 Native baseline，也不是安全能力已启用。当前没有真实 Chrome 宿主四象限证据，Safety、Handoff、Credential protection 仍应保持未激活。

WP-LAB-000 已完成合同与状态冻结；WP-LAB-001、WP-LAB-002 尚未开始。当前工作区在交接前应保持干净，后续云端 Agent 从本分支继续，不直接修改 `main`，每个工作包独立提交。

## 首要问题

1. **产品与 Lab 仍混合**：默认构建仍会打包 session recorder、evidence/release gate、pilot 和 handoff probe；产品 Skill/README 仍含实验与 credential fixture 说明。
2. **Hook 未证明接管真实 Chrome 路由**：已有 Hook/诊断只能证明本地代码路径或合成冒烟，不能证明宿主实际投递、动作粒度、页面聚焦、独占租约和结果时序。
3. **授权交接没有可靠闭环证据**：Chrome 必须保持同一个可见 tab；登录、MFA、CAPTCHA 和 OAuth 必须由用户在该真实页面完成，完成后由同一会话续跑。Oxrail 不得关掉、隐藏、替换或复制页面，也不得接触凭据。

## 云端 Agent 下一步

严格按 canonical `spec/OXRAIL_SPEC.md` 和附件合同执行：

- `WP-LAB-001`：拆分 `build-product` / `build-lab`，建立产品安装白名单、依赖清单和 staged install 验证；产品包不得包含 Lab、experiments、benchmarks、evidence、Demo 或监控入口，但必须保留安全锁、租约、pending/recovery 和宿主验证状态。
- `WP-LAB-002`：将 recorder/evidence/credential fixture 和 probe 迁移到独立 `lab/`，Lab 使用独立安装、配置和 `~/.oxrail-lab` 数据根；产品构建不得传递依赖 Lab。
- 后续 `WP-LAB-003` 至 `WP-LAB-007`：先实现独立宿主事件采集，再做 Chrome `codex-local-hook-v1` 真实证据、干净 Native Tuned/Oxrail 配对实验和发布门。
- 未取得真实宿主证据的能力必须标记 `UNKNOWN` 或 `BLOCKED`；不可用 mock、缺失 token、`BYPASSED` 或未执行的测试填充证据。

## 本地试用方式

在云端 Agent 完成并推送可安装包前，本地只做受控验证，不把结果当产品能力证明：

1. 安装云端 Agent 提供的 release artifact；运行产品 `doctor`，确认当前 Hook hash、HostProfile、路由、租约和恢复状态。
2. 人工在宿主 `/hooks` 检查并信任**当前版本 hash**；安装、setup、doctor 不得替用户信任 Hook。
3. 使用同一个可见 Chrome tab 启动无秘密任务，例如打开公开页面并读取公开标题。禁止隐藏窗口、临时新建登录 tab、复制页面或关闭用户 tab。
4. 出现登录、OAuth、MFA 或 CAPTCHA 时，Agent 应在当前可见 tab 停止并显示明确的 `AUTH_PENDING` 入口；用户只在该页面操作，完成后发送一次“已完成”，Agent 继续原任务。
5. 实验记录必须由独立 Lab 显式启动，产品默认不采集。任务结束先停止 Lab，再查询 session 级 token、耗时、Browser 调用次数和阶段事件；Host 未提供 token 时只能返回 `null` 及原因。

## 当前验证记录

- `node scripts/generate-spec-index.mjs`：exit 0。
- `pnpm validate:spec`：exit 0；`SPEC.md` 与 canonical spec 保持字节一致，索引和 checksum 已更新。
- `pnpm test`（WP-LAB-000 前基线）：exit 1，528 passed / 2 skipped / 1 failed；既有 `tests/evidence-gate.test.ts` 完整 release matrix 在 30 秒超时。
- `pnpm check`：exit 1；format、lint、typecheck 通过，测试仍为上述同一超时；后续链式校验未执行。
- 真实 Chrome、独立 Lab、四象限、授权交接和凭据安全：未执行，不能计为 PASS。

## 交接约束

- 不自动信任 Hook，不直接改 `main`，不推送 tag/release。
- 不采集真实凭据、输入值、剪贴板、截图、原始私有页面或完整工具输入输出。
- Native Computer Use 始终是浏览器唯一写执行者；Oxrail 只做可验证路由、状态、安全边界和恢复协调，不重放或替代鼠标键盘动作。
- 若宿主接口或隔离无法证明，保留证据并明确 `BLOCKED`，继续不依赖该阻断项的构建工作。
