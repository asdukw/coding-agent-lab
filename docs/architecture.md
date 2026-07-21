# 架构概览

Coding Agent Lab 通过独立实现控制面，研究不可信模型输出如何在可审批、可恢复、可验证的边界内操作代码。项目不是 Claude Code 或 Codex 的复刻，也不把当前 Windows runner 描述为完整恶意代码隔离。

## 分层与信任边界

| 区域 | 职责 | 信任假设 |
| --- | --- | --- |
| Bun / TypeScript 控制面 | Agent Loop、计划与权限状态、工具调度、Session、Memory、MCP 适配 | 可信，负责约束模型输出与副作用 |
| 模型与项目指令 | 生成回复、计划和工具调用 | 不可信，不能直接执行副作用 |
| 内置文件工具 | 在 workspace 内执行读取、搜索和修改 | 运行在可信 Bun 进程中，依赖路径与权限校验 |
| Rust / Win32 runner | 为 Windows `Shell` 建立 restricted token、ACL 与 Job Object 边界 | 可信，协议失败时不降级执行 |
| PowerShell 进程树 | 执行模型请求的命令 | 不可信；限制写入和普通子进程树，但不隔离读取与网络 |
| stdio MCP Server | 提供外部工具 | 外部进程，不受 Windows runner 隔离；调用按危险工具审批 |

主要实现入口：

- Agent Loop：[`src/query.ts`](../src/query.ts)
- 运行时状态与计划：[`src/state.ts`](../src/state.ts)、[`src/plan.ts`](../src/plan.ts)
- 权限与工具调度：[`src/tools/permissions.ts`](../src/tools/permissions.ts)、[`src/tools/runner.ts`](../src/tools/runner.ts)
- Session：[`src/sessionStore.ts`](../src/sessionStore.ts)
- Sub-agent：[`src/agents/`](../src/agents/)
- MCP 与 Memory：[`src/mcp/`](../src/mcp/)、[`src/memory.ts`](../src/memory.ts)、[`src/memoryDoctor.ts`](../src/memoryDoctor.ts)
- Windows 执行边界：[`src/sandbox/`](../src/sandbox/)、[`native/windows-sandbox-runner/`](../native/windows-sandbox-runner/)

## 请求到副作用

```text
用户输入
  → Agent Loop 调用模型
  → 解析结构化工具调用
  → 计划状态与工具权限检查
  → 资源锁内重新校验
  → 内置文件工具 / MCP / Windows Shell
  → 工具结果回到上下文
  → Session 事件持久化
```

计划审批与工具审批是两层独立状态：计划获批只允许进入执行阶段，不会自动授权危险工具。单次授权只覆盖当前批次；进程级授权不会写入 Session，恢复后待执行调用仍需重新校验。该取舍见 [ADR 0001](adr/0001-explicit-agent-control-state-machine.md)。

`auto` 使用 sandbox-first 权限流：普通 Shell 调用先在 `workspace_write` 边界内执行，不产生工具审批；如果模型根据失败结果判断命令确实需要边界外权限，必须以 `dangerously_disable_sandbox: true` 发起新的 Shell 调用，该调用在启动前进入正常审批流。审批不会触发控制面自动重放，避免已经在 sandbox 内产生部分副作用的命令被隐式执行第二次；即使用户曾对 Shell 选择“本会话不再询问”，显式 sandbox bypass 仍必须重新审批。外部 MCP 副作用不受本地 sandbox 约束，因此继续在执行前审批。

该授权取舍见 [ADR 0004](adr/0004-sandbox-first-auto-mode.md)。

当前 Win32 runner 的 `workspace_write` 只强制工作区写边界和进程树生命周期，宿主读取与网络仍未隔离；UI、工具结果与文档必须持续披露这一限制。`auto` 的这一阶段首先对齐“sandbox 内默认允许、显式越界再审批”的控制流，不能宣称已经达到同时隔离文件读取与网络的完整恶意代码 containment。

## 状态、并发与恢复

- Session 使用 JSONL 事件表达对话、工具调用、状态快照和 Memory Extraction 结果。
- 同一进程内，同一 Session 的保存与追加通过串行队列协调；当前不提供跨进程锁。
- 完整快照先写同目录临时文件，再替换目标；恢复只容忍文件末尾未完成的一条 JSON，中间损坏或语义不一致会失败。
- Sub-agent 由 [`src/agents/manager.ts`](../src/agents/manager.ts) 管理，并通过 [`src/agents/mailbox.ts`](../src/agents/mailbox.ts) 与父 Agent 通知协作。
- 工具资源由 [`src/tools/resourceLock.ts`](../src/tools/resourceLock.ts) 协调，持锁后仍需对关键路径身份重新校验。
- Memory mutation 另通过 SQLite `BEGIN IMMEDIATE` 协调多个 cagent 进程；取得事务后用 `PRAGMA quick_check` 验证锁库，损坏时 fail-closed。Memory Edit 的读取、校验、写入和索引刷新共享一个锁边界，并在提交前验证文件版本。
- Memory Doctor 直接执行有界只读扫描，不调用 Store 初始化或 mutation lock，因此不会创建目录、索引、SQLite 锁库或临时文件。它复用 topic 校验、精确去重和索引生成语义；路径安全失败、不可读文件、文件系统错误或并发修改导致的不完整扫描统一映射为退出码 `2`。

持久化选择及故障语义见 [ADR 0002](adr/0002-jsonl-session-recovery-semantics.md)。
Memory 的本地文件系统攻击者范围与残余 TOCTOU 风险见 [ADR 0003](adr/0003-memory-filesystem-threat-model.md)。

## Windows Shell 边界

`Read`、`Write`、`Edit`、`Glob` 和 `Grep` 由 Bun 控制面直接执行，不经过原生 runner。只有 Windows 主 Agent 的 `Shell` 使用 [`cagent-windows-sandbox-runner`](../native/windows-sandbox-runner/README.md)。

runner 的目标是限制本地文件写入并管理普通子进程树生命周期。它不提供网络隔离、宿主可读数据的保密隔离、文件回滚或对系统 broker 创建的 Job 外进程的完整控制。详细协议、信任假设和残余风险以[原生 runner 说明](../native/windows-sandbox-runner/README.md)为准。

## 证据边界

| 主张 | 自动验证 |
| --- | --- |
| Agent Loop 与结构化工具调用 | [`tests/query.tool.test.ts`](../tests/query.tool.test.ts) |
| Plan Mode 与危险工具审批 | [`tests/planMode.test.ts`](../tests/planMode.test.ts)、[`tests/permissionApproval.test.ts`](../tests/permissionApproval.test.ts) |
| Session 写入、恢复与损坏处理 | [`tests/sessionStore.test.ts`](../tests/sessionStore.test.ts) |
| Sub-agent 与 Mailbox | [`tests/agentManager.test.ts`](../tests/agentManager.test.ts)、[`tests/agentMailbox.test.ts`](../tests/agentMailbox.test.ts) |
| MCP 与 Memory | [`tests/mcp.test.ts`](../tests/mcp.test.ts)、[`tests/memory.test.ts`](../tests/memory.test.ts)、[`tests/memoryDoctor.test.ts`](../tests/memoryDoctor.test.ts)、[`tests/memoryDoctorCli.test.ts`](../tests/memoryDoctorCli.test.ts)、[`tests/integration/memoryMutationLock.test.ts`](../tests/integration/memoryMutationLock.test.ts) |
| Windows restricted-token 执行边界 | [`tests/integration/windowsSandbox.test.ts`](../tests/integration/windowsSandbox.test.ts) 与 [CI](../.github/workflows/ci.yml) 的 Windows release runner E2E |

确定性离线 Demo（[`src/demo/offlineDemo.ts`](../src/demo/offlineDemo.ts)）用于证明 Agent Loop、审批、文件工具和 Session 恢复能够端到端协作。为保证跨平台、无密钥和结果可重复，它刻意不调用 `Shell`，因此**不证明 Windows Sandbox 生效**；Windows 边界只由原生单元测试和真实 runner E2E 提供证据。
