# Windows Sandbox Runner

`cagent-windows-sandbox-runner` 是 Windows 上 `Shell` 工具的可信原生启动器。Bun 主进程通过有界 JSON 协议提交一次命令；runner 使用 restricted token、NTFS ACL、显式继承句柄列表和 Job Object 启动不可信 PowerShell 进程树。它不是虚拟机、容器或保密沙箱。

## 构建与安装

前置条件：Windows 11 x64、`rustup`、`1.96.0-x86_64-pc-windows-msvc`，以及带 C++ x64 工具链的 Visual Studio 2022 Build Tools/Community。仓库内的 `rust-toolchain.toml` 同时固定该版本及 `rustfmt`、`clippy` 组件。

在仓库根目录运行：

```powershell
bun run build:sandbox
```

脚本初始化 Visual Studio 2022 x64 环境，构建 release runner，并通过同目录原子替换安装到：

```text
%USERPROFILE%\AppData\Local\cagent\bin\cagent-windows-sandbox-runner.exe
```

CI 或只需要产物、不希望写入固定 helper 安装目录时，直接给脚本传入绝对 Cargo 目标目录，不要使用 `-Install`：

```powershell
$cargoTargetDir = Join-Path $env:TEMP "cagent-windows-sandbox-runner-target"
.\scripts\build-windows-sandbox.ps1 -CargoTargetDir $cargoTargetDir
```

两种模式都会输出最终路径和 SHA256。安装模式的 Cargo 中间产物位于 `%USERPROFILE%\AppData\Local\cagent\build\windows-sandbox-runner\`；纯构建模式不会创建固定 helper 安装目录，Cargo target 输出位于指定目标目录。rustup 和 Cargo 仍可能读写各自的用户级工具链、registry 与下载缓存。脚本使用标准 rustup 用户安装位置、显式选择固定版本的 `rustc`/`rustdoc`/`cargo`、清除常见编译 wrapper/flags，并带 `--locked` 构建。Rust 与 Cargo 依赖已经固定，但 Visual Studio 和 Windows 构建环境尚未完全固定，因此仍不承诺位级可复现。CLI 默认只从上述固定用户目录加载 helper，并校验它是 workspace 外的普通文件；当前不校验签名或发行哈希。

## 执行流程

1. CLI 启动时固定 workspace 根，并校验 helper 的规范路径和文件类型；runner 通过 `GetSystemDirectoryW` 固定解析系统 Windows PowerShell，不接受客户端指定 executable，恢复的 session 也不能动态扩大 workspace 根。
2. runner 严格校验协议、带本地盘符的绝对路径、非盘符根、互不重叠的写根，以及位于写根内的 `cwd`。M1 不额外查询 drive type 或证明文件系统一定是 NTFS。
3. runner 先在 workspace 内安全地实体化 `.cagent`，再为每个写根派生路径作用域 capability SID。每次启动都会拒绝含多硬链接普通文件的 workspace；首次安装根 ACE 时还会拒绝任意已有 reparse point，避免自动继承传播越过路径边界。扫描通过后写入持久、可继承且幂等的 allow ACE；已有 ACE 时跳过重复传播，敏感路径另加 deny ACE。
4. runner 在首个 workspace 的 `.cagent-sandbox/profiles/` 中逐级校验并创建每请求唯一的临时 profile，单独授予 capability，并覆盖 `USERPROFILE`、`HOME`、`APPDATA`、`LOCALAPPDATA`、`TEMP`、`TMP`、`HOMEDRIVE`、`HOMEPATH`。结束时仅在路径仍规范地位于该 workspace、且未变成 reparse point 时 best-effort 删除。
5. `CreateRestrictedToken` 使用 `DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED`；传给目标的环境是白名单，不包含模型 API Key。
6. 仅 stdin/stdout/stderr 出现在 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 中。Job 在启动前配置 kill-on-close 与 UI restrictions，并通过 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在创建目标时原子关联；目标以 `CREATE_SUSPENDED | CREATE_NO_WINDOW` 创建，`IsProcessInJob` 复验成功后才恢复线程。
7. runner 在启动目标前打开并校验请求中的宿主 PID，运行期间持续监控该句柄。宿主退出、超时、取消或 runner 退出时都会终止或关闭 Job；根进程正常退出时也会关闭 Job，先清理残留 Job 成员，再把管道读到 EOF。

一次 `Shell` 调用只有一个根命令，但允许 `git`、`bun`、编译器等创建正常的子进程树。Bun runtime 使用 workspace 子树写锁、sandbox 进程写锁和全局 opaque 写屏障，因此当前单进程版本一次只执行一个 `Shell` 调用。普通工具共享 opaque 读屏障；持锁后会重新解析 realpath/File ID，资源身份变化时释放并重试。

## M1 安全边界

### 文件与配置完整性

- 读取沿用当前 Windows 用户权限，设计上近似全盘可读。
- restricted token 的本地文件系统写入只允许固定 workspace；本次临时 profile 也位于 workspace 内。workspace 根目录项本身不能被沙箱删除或重命名。
- workspace 根级现存的 `.cagent`、`.mcp.json`、`AGENTS.md`、`CLAUDE.md`、`.env*` 会被 deny-write/delete。普通 `.git` 目录对象不能被重命名/删除，现存 `config` 与 `hooks` 受完整写保护，同时保留 index/object/ref 写入；worktree 的 `.git` gitfile 整体保护。
- 敏感路径若为 reparse point，runner fail closed。NTFS 无法为尚不存在的任意 `.env.*` 名称预设文件 ACE，因此这项保护只覆盖命令启动前已经存在的匹配项。
- capability ACL 是宿主上的持久元数据，不会随命令回滚。相同规范化路径使用稳定 SID，重复执行不会持续追加相同 ACE；目录改名或对象被外部进程移动后，旧 ACE 仍需按持久 ACL 对待。
- 稳定 SID 也意味着对象漂移边界：若沙箱外、具有宿主权限的进程把带 capability ACE 的对象移出 workspace，后续同 workspace 的 restricted token 仍可能写该对象。M1 没有安全撤销任意外移 ACE 的机制；要消除该缺口，需要每次运行的随机 capability 与可靠回收、broker/minifilter，或更强的系统隔离。
- Windows 会把新增的可继承 ACE 自动传播到现有子对象。runner 每次启动都拒绝任何链接计数大于 1 的普通文件；首次安装 allow ACE 时还拒绝任意已有 reparse point，避免首次自动传播沿特殊路径越界。根 ACE 已存在后的扫描不会跟随 reparse point。该检查是安全优先的兼容性和性能取舍。
- reparse/hardlink 扫描到 `SetNamedSecurityInfoW` 之间仍有路径式 TOCTOU。M1 的威胁模型假设没有并发的对抗性宿主进程修改 workspace；若以后把外部并发攻击者纳入边界，应改为 handle-relative 操作并核验 File ID。
- 默认 helper 位于 workspace 外。若错误地把 runner 放进某个写根，原生端还会保护自身文件及父目录，阻止下一次调用被替换。

Shell 的文件修改直接落在宿主 workspace；M1 没有快照、copy-on-write 或自动回滚。

### 进程生命周期

- 目标由创建属性原子加入 Job，并保持 suspended 直到成员资格复验完成；任何安全步骤失败都拒绝运行，不会降级到普通 `spawn`。
- 句柄继承采用显式白名单；Job 使用 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。
- Job UI restrictions 阻止跨 Job USER handle、剪贴板读写、desktop 创建/切换、global atom、显示/系统参数修改与 `ExitWindows`。
- Job 只覆盖成功加入它的进程。经 WMI/CIM、计划任务或其他系统 broker 创建的进程可能不继承调用方 Job，并可能在 Shell 返回后继续运行；M1 对这些 Job 外进程不提供生命周期隔离。
- 输出按总字节预算持续排空，防止管道死锁；协议与 helper stderr 也有独立上限。
- M1 未设置 CPU、内存或磁盘配额。
- 正常栈展开会 best-effort 清理临时 profile；若 helper 被强杀，可能遗留 workspace 内的 `.cagent-sandbox/profiles/*`，后续可人工清理。

### 网络与保密性

M1 **不隔离网络**。`enforcement.network` 固定返回 `inherited_not_isolated`；restricted token 无法可靠阻止 Winsock 出站连接。

M1 也不是保密边界：目标仍可读取当前用户有权读取的文件、部分注册表/进程状态。Job UI restrictions 限制了常见 UI shatter 与剪贴板路径，但目标仍运行在默认 desktop，没有私有 desktop 或完整 GUI/凭据保险库隔离。环境白名单只防止凭据被直接继承，不能替代独立账户、AppContainer 或 WFP。不要把 M1 描述成“断网”或“可安全运行任意恶意程序”的沙箱。

## Agent 集成边界

- `Shell` 只注册在 Windows 主 Agent 的普通、无额外 write policy 模式；plan、memory 与所有 sub-agent 都拿不到它。
- Read、Write、Edit、Glob、Grep 等现有工具仍在可信 Bun 主进程中执行，不经过 runner。原生敏感路径 deny ACE 只约束 restricted token，因此不会阻止这些宿主工具按其自身权限修改文件。
- Shell 造成的文件变化暂不写入 Agent 的 `changedFiles`。
- M1 当前只支持单 Bun 进程内的锁与队列，不提供跨进程协调。
- 初始 workspace 是信任基线。runner 会在首次 Shell 前实体化并保护 `.cagent`，但不会证明仓库初始内容可信；workspace MCP 配置也应只用于可信仓库。
- 正式部署时，Bun 控制面、runner 和启动配置应安装在目标 workspace 外，并禁用目标仓库对 dotenv、preload 等启动行为的影响；源码自托管模式不是跨重启完整性边界。
- 当前 `bin/cagent` 仅关闭 dotenv 自动加载，不能阻止目标 workspace 的 `bunfig.toml` preload 在入口前执行。正式发行应使用 Bun 的 `--no-compile-autoload-dotenv --no-compile-autoload-bunfig` 构建 standalone executable，或使用等价的可信原生启动器。

## 协议

runner 从 stdin 读取不超过 1 MiB 的单个 JSON 请求，并向 stdout 写一个 JSON 响应。协议版本为 `1`。

请求字段：`version`、`request_id`、`parent_pid`、`args`、`cwd`、`writable_roots`、`env`、`timeout_ms`、`max_output_bytes`。`parent_pid` 必须是仍存活且不同于 runner 的宿主进程；目标固定为系统目录中的 `WindowsPowerShell\v1.0\powershell.exe`。

响应包含 `status`、退出码、stdout/stderr、超时与截断标记、结构化 Windows 错误，以及协议声明的 enforcement 模式。错误响应也会声明目标模式，它不表示失败前所有 enforcement 步骤都已实际施加。未知字段、版本不匹配、路径或 ACL 校验失败都会 fail closed。

## 借鉴与后续

cc-haha 提供了“启动时建立策略、allow 内再 deny 高风险配置、失败不静默降级”的集成思路；原生执行边界主要参考 Codex Windows runner 的 restricted token、路径 capability SID、ACL 与句柄白名单设计。本实现额外使用创建属性让目标原子进入 Job，并在恢复目标线程前复验成员资格。

后续若需要保密性和可靠断网，应增加受保护的独立 Windows 账户与 WFP，或在兼容性验证后引入 AppContainer；不能用代理环境变量冒充网络隔离。
