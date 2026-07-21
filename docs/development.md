# 开发与验证

本文面向阅读源码、运行检查和维护发行流程的开发者。首次使用项目请先阅读[使用指南](usage.md)，信任边界见[架构概览](architecture.md)。

## 项目结构

```text
src/
  agents/                 Sub-agent runtime 与 mailbox
  demo/                   离线 / 真实模型场景、报告与 CLI
  mcp/                    MCP 配置、发现与适配
  model/                  模型抽象、DeepSeek 与 Stub
  sandbox/                Windows Sandbox TypeScript 控制面
  tools/                  内置工具、审批与资源调度
  ui/                     Ink 终端界面与生命周期
  query.ts                Agent Loop
  memoryDoctor.ts         只读 Memory 扫描、报告与退出码
  sessionStore.ts         JSONL Session 持久化与恢复
native/
  windows-sandbox-runner/ Rust / Win32 原生 runner
examples/offline-demo/    复制到临时 workspace 的 Demo fixture
docs/                     使用、架构、ADR 与发布说明
tests/                    Bun 单元测试与 Windows E2E
```

## 推荐阅读顺序

| 入口 | 关注点 |
| --- | --- |
| [`src/query.ts`](../src/query.ts) | Agent Loop、结构化 Tool Call、暂停与继续 |
| [`src/tools/permissions.ts`](../src/tools/permissions.ts) | Plan、工具审批与 sandbox-first Auto |
| [`src/sessionStore.ts`](../src/sessionStore.ts) | JSONL 事件、尾部修复、快照与严格恢复 |
| [`src/agents/`](../src/agents/) | Sub-agent、Mailbox、取消与资源调度 |
| [`src/memory.ts`](../src/memory.ts) | Memory 校验、事务修改与索引 |
| [`native/windows-sandbox-runner/`](../native/windows-sandbox-runner/) | Restricted Token、ACL、Job Object 与 PowerShell 选择 |

## 本地检查

```text
# 格式与 lint
bun run check:style

# TypeScript
bun run check

# 确定性离线端到端 Demo
bun run demo:offline

# 离线单元测试
bun run test:unit

# Memory 跨进程锁专项测试
bun run test:memory-lock

# 需要真实凭据和网络
bun run test:deepseek
```

`test:unit` 自动发现 `tests/**/*.test.ts`，排除需要真实凭据或原生 runner 的专用测试，并让每个测试文件在独立 Bun 进程中运行，避免进程级单例或开放句柄跨文件污染。

Windows Release runner 的真实 E2E 需要显式配置：

```powershell
$env:CAGENT_WINDOWS_SANDBOX_INTEGRATION = "1"
$env:CAGENT_WINDOWS_SANDBOX_HELPER = "C:\absolute\path\to\cagent-windows-sandbox-runner.exe"
bun run test:sandbox
```

## CI 证据

GitHub Actions 当前验证：

- Ubuntu Quality：Biome 与 TypeScript。
- Ubuntu / Windows：离线 Bun 测试。
- Ubuntu / Windows：Memory 跨进程事务锁专项测试。
- Ubuntu / Windows：确定性离线 Demo 与脱敏报告 artifact。
- Windows 2022：Rust fmt、Clippy、单元测试、Release 构建与真实 Sandbox E2E。
- `v*` tag：重新执行完整验证，生成 Windows x64 ZIP 与 SHA256，并在打包后 smoke / Sandbox E2E 通过后发布 GitHub Release。

`demo:deepseek` 与 `test:deepseek` 依赖真实凭据、外部 API 和非确定性模型输出，因此不进入常规 CI。

## 发版入口

```powershell
bun run build:release
bun run test:release
```

发行说明保存在 [`docs/releases/`](releases/)，Windows runner 的完整构建、协议和残余风险说明见[原生 runner README](../native/windows-sandbox-runner/README.md)。
