# 使用指南

本文包含 Coding Agent Lab 的发行版安装、源码运行、权限模式、交互命令、MCP、Session 与 Memory 使用方式。项目架构和安全边界见[架构概览](architecture.md)。

## 支持范围

- Windows 11 x64 是主要运行与开发平台，内置 `Shell` 由 Rust / Win32 runner 执行。
- 推荐安装 PowerShell 7。cagent 启动时优先解析受信任的 `pwsh.exe`；若只能使用系统 Windows PowerShell 5.1，会打印兼容性警告及升级指引，然后继续以 5.1 fallback 运行。
- Ubuntu 可以运行控制面、离线 Demo 和单元测试，但不会注册内置 `Shell`。
- 其他平台尚未作为支持目标验证。

安装或更新 PowerShell 7 后，请重启 cagent：

```powershell
winget install --id Microsoft.PowerShell --source winget
# 已安装旧版 PowerShell 7 时：
winget upgrade --id Microsoft.PowerShell --source winget
```

## Windows x64 发行版

[GitHub Release](https://github.com/asdukw/coding-agent-lab/releases/latest) 提供不依赖本机 Bun、Rust、Visual Studio 或 npm link 的 Windows x64 ZIP。下载 ZIP 与同名 `.sha256` 后，先校验 SHA256，再解压到目标仓库之外的稳定目录，例如 `%LOCALAPPDATA%\Programs\CodingAgentLab\current`。

包内的 `cagent.exe` 与 `cagent-windows-sandbox-runner.exe` 必须保持同目录：

```powershell
Set-Location C:\path\to\target-repository
C:\path\to\CodingAgentLab\cagent.exe --version
C:\path\to\CodingAgentLab\cagent.exe "分析当前仓库"
```

发行 EXE 支持 `--help`、`--version`、`--resume <session-id>` 和 `--memory-check`。它不会读取目标 workspace 的 `.env`，也不会经过目标 workspace 的 Bun 启动配置。当前二进制未做代码签名，runner 若位于可写 workspace 内会被安全策略拒绝。

## 从源码运行

项目固定使用 Bun `1.3.14`：

```powershell
bun install --frozen-lockfile
```

### 配置模型

当前真实模型适配器使用 DeepSeek 的 OpenAI-compatible API。`start` 入口不自动加载 workspace `.env*`，请在父进程中设置环境变量：

```powershell
$env:DEEPSEEK_API_KEY = "your-key"
$env:DEEPSEEK_BASE_URL = "https://api.deepseek.com"
$env:DEEPSEEK_MODEL = "deepseek-v4-flash"
```

源码 `dev` 为本仓库开发便利而显式使用 `--env-file=.env` 并开启 watch，只应在可信的项目副本中运行。请勿提交包含密钥的 `.env`。

如果未设置 `DEEPSEEK_API_KEY`，应用会使用确定性的 Stub Model，适合查看 UI、Session 和基础交互，但不会执行真实 Coding Agent 推理。

Windows 下源码 `start` 即使使用 Stub Model 也会初始化原生 runner，因此仍需先完成下一节的 runner 构建；`--memory-check` 不需要模型或 runner。

### 构建 Windows Sandbox runner

源码方式使用内置 `Shell` 前，需要 Rustup、Visual Studio 2022 C++ Build Tools，以及 runner 文档中列出的固定 Rust 工具链。完整前置条件见[原生 runner 构建说明](../native/windows-sandbox-runner/README.md#构建与安装)。

```powershell
bun run build:sandbox
```

构建脚本会把 release runner 原子安装到：

```text
%USERPROFILE%\AppData\Local\cagent\bin\cagent-windows-sandbox-runner.exe
```

更新源码后应重新执行 `bun run build:sandbox`，确保控制面与 runner 协议匹配。PowerShell 选择、fallback、协议和信任规则以[原生 runner 文档](../native/windows-sandbox-runner/README.md)为准。

### 启动

```powershell
bun run start
bun run start "分析当前仓库并给出下一步计划"
```

无需启动模型、MCP、Windows runner 或交互界面，即可只读检查 Memory：

```powershell
bun run start --memory-check
```

退出码 `0` 表示扫描完成且没有问题，`1` 表示发现可治理问题，`2` 表示扫描无法可信完成。

## 权限模式

`/permissions` 提供三档预设：

| 模式 | 行为 |
| --- | --- |
| `ask` | workspace 修改、Shell 和 MCP 在执行前询问；这是默认模式 |
| `auto` | workspace 文件操作和 sandboxed Shell 默认执行；显式 sandbox bypass 与 MCP 仍需审批 |
| `full` | 关闭交互审批和文件系统 sandbox，以宿主用户权限执行 |

`auto` 使用 sandbox-first 流程。普通 Shell 调用先在 `workspace_write` 边界中执行；若结果表明命令确实需要越界，模型必须发起带 `dangerously_disable_sandbox: true` 的新调用，控制面会在启动前请求审批。控制面不会自动以更高权限重放失败命令，已有 Shell session grant 也不能静默授权 bypass。

当前 Win32 runner 约束 workspace 外写入和普通进程树生命周期，但不隔离宿主读取与网络；`auto` 不能视为完整恶意代码 containment。详见[架构概览](architecture.md)与[原生 runner 安全边界](../native/windows-sandbox-runner/README.md#安全边界)。

切换模式会先取消并等待当前 Session 的活跃 Sub-agent 停止，并清除旧模式下的进程级授权和待审批决定。权限模式和“本会话不再询问”授权都不会写入 Session；恢复后回到 `ask`，待执行调用必须重新校验。

## 交互命令

| 输入 | 作用 |
| --- | --- |
| `/plan` | 进入 Plan Mode，计划获批前不执行修改 |
| `/permissions` | 打开权限模式选择器 |
| `/permissions ask\|auto\|full` | 直接切换权限模式 |
| `/resume <session-id>` | 恢复指定 Session |
| `/memory` | 初始化并显示当前 workspace 的 Memory Store |

审批使用方向键与 Enter，或数字快捷键。工具审批可选择仅批准当前批次、当前进程会话内不再询问这些工具，或拒绝；Esc 对待执行操作采用安全取消。

## MCP 配置

项目只从 workspace 根目录的 `.cagent/mcp.json` 读取配置：

```json
{
  "mcpServers": {
    "example": {
      "type": "stdio",
      "command": "example-mcp-server",
      "args": [],
      "env": {}
    }
  }
}
```

MCP Server 是外部进程，可能拥有 workspace sandbox 之外的副作用，因此其工具在 `ask` 和 `auto` 下进入审批流。

## Session 与 Memory

- Session 事件保存在 `.cagent/sessions/*.jsonl`。
- Session Index 位于 `.cagent/sessions/session_index.jsonl`；每个 Session 只保留最新条目并原子替换。
- 长期 Memory 位于 `.cagent/memory/`；Memory Agent 只能写入这里。
- `.cagent/memory/MEMORY.md` 根据 topic frontmatter 自动维护，不能直接修改。
- Memory mutation 通过 SQLite 锁协调同进程与跨进程修改，锁库损坏时 fail-closed。
- `Write` / `Edit` Memory topic 时会执行路径、格式、重复与并发版本校验。
- Memory Extraction 结果通常写入 Session；Session 事件无法持久化时才回退到 `.cagent/audit/memory-extraction/`。

Session、审计和 MCP 配置属于 Agent 控制数据，普通文件工具不能直接访问；`.cagent/memory/` 是唯一受专用验证流程约束的例外。

## Demo

无需 API Key 的确定性场景：

```powershell
bun run demo:offline
```

真实 DeepSeek 人工审批场景：

```powershell
Copy-Item .env.example .env
# 编辑 .env，填写 DEEPSEEK_API_KEY
bun run demo:deepseek
```

`demo:deepseek` 会把 fixture 复制到临时 workspace，只向模型提供 `Read`、`Edit`、`UpdatePlan` 与 `ExitPlanMode`，不暴露 `Shell`。仓库 fixture 不会被修改，脱敏报告也不记录 API Key、完整 Prompt、模型输出或工具参数。它会访问真实 API，输出和调用次数不确定，也可能产生费用，因此不进入常规 CI。
