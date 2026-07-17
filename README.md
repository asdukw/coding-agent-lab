# coding-agent-learn

To install dependencies:

```bash
bun install
```

Configure DeepSeek in the parent process environment (PowerShell example):

```powershell
$env:DEEPSEEK_API_KEY = "your-key"
$env:DEEPSEEK_BASE_URL = "https://api.deepseek.com"
$env:DEEPSEEK_MODEL = "deepseek-v4-flash"
```

The source launcher disables Bun's automatic `.env*` loading. This prevents a
sandboxed command from planting a dotenv file that changes the model endpoint
or receives credentials on the next launch. It is still a development launcher:
Bun may load `bunfig.toml` from the current working directory before the entry
module runs. A production launcher must also disable bunfig autoload.

To run:

```bash
bun run start
```

## 项目上下文与工具审批

每次 query 会加载 workspace 到当前目录之间的项目指令。同一目录优先使用 `AGENTS.md`，仅在其不存在时读取 `CLAUDE.md`；更深目录的指令优先级更高。指令只作为模型 system context 注入，不写入会话消息，并受单文件与总字节上限约束。符号链接、junction/reparse point 或越界路径会被拒绝。

主 Agent 在 normal mode 调用 `Write`、`Edit`、`Shell` 或 MCP 工具前会暂停整批 tool calls，并显示工具名、参数摘要和风险原因：

- 输入 `allow`：只批准当前批次。
- 输入 `always`：在当前进程会话内持续批准这些工具名；该授权不会随 `/resume` 恢复。
- 输入 `deny`：不执行被拒绝的危险调用，并向模型返回协议完整的错误 tool result。

`Read`、`Glob`、`Grep`、`Write` 和 `Edit` 始终受 workspace 规范路径检查约束，不能访问 `.env*`、`.git`、`.cagent-sandbox` 或 `.cagent` 控制数据（受验证的 `.cagent/memory` 路径除外）。交互批准不能覆盖这些静态边界。`Shell` 与 MCP 属于不透明工具，其额外边界见下方 sandbox 说明。

## Windows 原生 Sandbox（M1）

Windows 上的 Shell 工具使用独立 Rust runner 创建受限进程。首次使用前构建 runner：

```powershell
bun run build:sandbox
```

该命令显式选择 `stable-x86_64-pc-windows-msvc` release toolchain，并通过同目录替换安装到固定用户目录：

```text
%USERPROFILE%\AppData\Local\cagent\bin\cagent-windows-sandbox-runner.exe
```

CLI 还会要求该文件的规范路径位于当前 workspace 外；构建脚本本身不承诺任意 workspace 都与上述目录互不包含。

M1 使用 restricted token、路径作用域 capability ACL、Job Object 和继承句柄白名单。一次 Shell 调用创建一个根命令，但允许其 Job 内子进程树运行；runner 退出、宿主进程消失、取消或超时时，Job 会终止仍存活的 Job 成员。

当前边界需要特别注意：

- 设计为全盘可读，但仍受当前 Windows 用户原有 ACL 限制。
- 对 restricted token 的本地文件系统写入仅允许在 workspace；临时 sandbox profile 位于首个 workspace 的 `.cagent-sandbox/profiles/` 内。
- 网络继承宿主用户权限，尚未隔离。
- capability ACL 持久存在，不会在每次命令后回滚。客户端拒绝 workspace 内的 helper；runner 自身及其父目录还会被 capability deny-write/delete 保护。
- Job 只约束其成员。WMI/CIM、计划任务等经系统 broker 创建的 Job 外进程可能在 Shell 返回后继续运行，M1 不把这类启动方式视为已隔离。
- runner 每次调用都拒绝 workspace 中已有的多硬链接普通文件；首次安装 capability ACL 时还会拒绝已有 reparse point。这是安全优先、可能影响大型或特殊仓库的兼容性取舍。
- capability SID 由规范化路径稳定派生。若具有宿主权限的外部进程把带 capability ACE 的对象移出 workspace，该对象仍可能被后续同 workspace 的 sandbox token 写入；M1 不提供对象漂移后的撤权。
- 路径扫描与 ACL 更新仍是路径式操作；M1 假设没有并发的对抗性宿主进程在两者之间替换目录项。更强边界需要改成 handle-relative/File ID 方案。
- M1 是完整性边界，不是保密边界；Job UI restrictions 会限制剪贴板和常见跨 Job UI 操作，但没有私有 desktop，也没有隔离网络、当前用户可读文件、凭据或进程状态。
- 初始 workspace 内容仍是信任基线；开发时若 agent 自身源码也位于 writable workspace 内，这种 self-host 模式不能作为跨重启完整性边界。正式安装应把 agent 控制面放在目标 workspace 外。
- 当前 `bin/cagent` 只是源码开发入口。目标 workspace 的 `bunfig.toml` 可在应用入口和 sandbox 初始化前执行 preload；正式发行应使用同时关闭 dotenv 与 bunfig 自动加载的 Bun standalone executable，或等价的可信原生启动器。
- Read、Write、Edit 等现有文件工具不经过该进程沙箱；敏感路径上的原生 deny ACE 只限制 restricted token，不限制这些由可信 Bun 控制面直接执行的宿主工具。
- Shell 造成的文件变化暂不加入 Agent 的 `changedFiles`。

完整协议、构建要求和安全边界见 [`native/windows-sandbox-runner/README.md`](native/windows-sandbox-runner/README.md)。

To verify DeepSeek connectivity:

```bash
bun run test:deepseek
```

The connectivity test is skipped when `DEEPSEEK_API_KEY` is not set.

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
