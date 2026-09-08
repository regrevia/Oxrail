# Lab 分离实施基线

- 原分支：dev。
- 原HEAD：6dbf338f666f77eefed5a7df76979c8e8b12d6a7。
- 功能分支：codex/lab-separation。
- 已有工作区快照：900793b（54文件，21550新增行，262删除行）；它保存此前开发，不是WP-LAB交付。
- 已有改动涵盖：update/doctor、实验记录器、Skill、native凭据fixture、对应测试及混合dist。快照保留本地host-inventory，禁止作为产品树发布。
- 实际基线命令：pnpm test，退出码1；528 passed、2 skipped、1 failed，共37测试文件。失败：tests/evidence-gate.test.ts完整release matrix用例超过30000ms；不改小断言或据此忽略发布门。
- 包装命令首次使用zsh只读变量status，包装退出1；随后使用exit_code重新执行，上述结果来自第二次有效运行。
- 原始基线输出保存在本机 /tmp/oxrail-baseline-test.log；它不是永久发布证据。
- 本轮真实宿主测试：未执行。既有人工投递Hook输入不构成真实宿主事件证据。
- 当前产品：passive adapter；Guard验证器未接入runHookCli，Handoff/凭据保护未激活。
- 下一包：WP-LAB-000规范、ADR和字段清单冻结；之后WP-LAB-001产品清包，再WP-LAB-002内部迁移。

正式实验必须在新宿主上下文确认实际加载清单与访问隔离。当前开发任务具有完整文件访问权，不能用本任务证明执行Agent无法访问Lab计划或报告。
