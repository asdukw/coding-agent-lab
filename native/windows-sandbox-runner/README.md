# Windows Sandbox Runner

`cagent-windows-sandbox-runner` 是 Windows 上 `Shell` 工具的可信原生启动器。Bun 主进程通过有界 JSON 协议提交一次命令；`workspace_write` 模式使用 restricted token 与 NTFS ACL 限制写入，`danger_full_access` 模式则显式使用当前宿主用户权限执行。两种模式都使用可信 PowerShell 路径、显式继承句柄列表和 Job Object 管理进程树。它不是虚拟机、容器或保密沙箱。

## 构建与安装

前置条件：Windows 11 x64、`rustup`、`1.96.0-x86_64-pc-windows-msvc`，以及带 C++ x64 工具链的 Visual Studio 2022 Build Tools/Community。`bun run build:sandbox` 由系统 Windows PowerShell 5.1 驱动；PowerShell 7 是运行命令时的推荐首选引擎，但不是构建前置条件。若 runner 只能回退到 Windows PowerShell 5.1，cagent 会在启动时打印兼容性警告和 PowerShell 7 升级指引。仓库内的 `rust-toolchain.toml` 同时固定该版本及 `rustfmt`、`clippy` 组件。

在仓库根目录运行：

```powershell
bun run build:sandbox
```

脚本初始化 Visual Studio 2022 x64 环境，构建 release runner，并通过同目录原子替换安装到：

```text
%USERPROFILE%\AppData\Local\cagent\bin\cagent-windows-sandbox-runner.exe
```

协议 v3 与旧的 v2 helper 不兼容。拉取使用 v3 的控制面源码后必须重新运行 `bun run build:sandbox`；安装脚本会原子替换上述固定位置的 runner。

CI 或只需要产物、不希望写入固定 helper 安装目录时，直接给脚本传入绝对 Cargo 目标目录，不要使用 `-Install`：

```powershell
$cargoTargetDir = Join-Path $env:TEMP "cagent-windows-sandbox-runner-target"
.\scripts\build-windows-sandbox.ps1 -CargoTargetDir $cargoTargetDir
```

两种模式都会输出最终路径和 SHA256。安装模式的 Cargo 中间产物位于 `%USERPROFILE%\AppData\Local\cagent\build\windows-sandbox-runner\`；纯构建模式不会创建固定 helper 安装目录，Cargo target 输出位于指定目标目录。rustup 和 Cargo 仍可能读写各自的用户级工具链、registry 与下载缓存。脚本使用标准 rustup 用户安装位置、显式选择固定版本的 `rustc`/`rustdoc`/`cargo`、清除常见编译 wrapper/flags，并带 `--locked` 构建。Rust 与 Cargo 依赖已经固定，但 Visual Studio 和 Windows 构建环境尚未完全固定，因此仍不承诺位级可复现。CLI 默认只从上述固定用户目录加载 helper，并校验它是 workspace 外的普通文件；当前不校验签名或发行哈希。

## 执行流程

1. CLI 启动时固定 workspace 根，并校验 helper 的规范路径和文件类型；runner 依次解析固定的 `Program Files\PowerShell\7\pwsh.exe`、PATH 中规范化后位于 `Program Files\PowerShell\7` 或 `7-*` 目录的普通 `pwsh.exe`，最后是由 `GetSystemDirectoryW()` 定位的 `WindowsPowerShell\v1.0\powershell.exe`。PATH 条目会先经过无 I/O 的严格词法布局过滤，无关目录直接忽略；只有进入可信布局的 PATH 候选和两个固定候选才会触发文件探测，对这些候选仅 `NotFound` 会继续解析，其他 I/O 错误均 fail closed。候选不满足普通、非 reparse 文件及 canonical containment 约束时也会继续下一项；命令一旦启动就不会换壳重试。客户端不能指定 executable，恢复的 session 也不能动态扩大 workspace 根。
2. runner 严格校验协议和 `cwd`。`workspace_write` 还会校验带本地盘符的绝对写根、非盘符根、互不重叠的写根，以及 `cwd` 必须位于某个写根内；M1 不额外查询 drive type 或证明文件系统一定是 NTFS。`danger_full_access` 不解析或安装写根 ACL。
3. 在 `workspace_write` 下，runner 先在 workspace 内安全地实体化 `.cagent`，再为每个写根派生路径作用域 capability SID。扫描到多硬链接普通文件时，会为本 workspace 的合成 SID 安装精确的 deny-mutation ACE，使该文件在沙箱中可读但不可写；首次安装根 ACE 时仍会拒绝任意已有 reparse point，避免自动继承传播越过路径边界。扫描通过后写入持久、可继承且幂等的 allow ACE；已有 ACE 时跳过重复传播，敏感路径另加 deny ACE。
4. 在 `workspace_write` 下，runner 在首个 workspace 的 `.cagent-sandbox/profiles/` 中逐级校验并创建每请求唯一的临时 profile，单独授予 capability，并覆盖 `USERPROFILE`、`HOME`、`APPDATA`、`LOCALAPPDATA`、`TEMP`、`TMP`、`HOMEDRIVE`、`HOMEPATH`。结束时仅在路径仍规范地位于该 workspace、且未变成 reparse point 时 best-effort 删除。
5. `workspace_write` 使用 `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED)` 和 `CreateProcessAsUserW`，并接收控制面提供的环境白名单。`danger_full_access` 跳过 restricted token/profile/ACL，使用 `CreateProcessW` 和请求中未经沙箱收窄的环境，因此拥有与 runner 当前用户相同的文件系统与网络权限。
6. 两种模式都仅让 stdin/stdout/stderr 出现在 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 中。Job 在启动前配置 kill-on-close 与 UI restrictions，并通过 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在创建目标时原子关联；目标以 `CREATE_SUSPENDED | CREATE_NO_WINDOW` 创建，`IsProcessInJob` 复验成功后才恢复线程。
7. runner 在启动目标前打开并校验请求中的宿主 PID，运行期间持续监控该句柄。宿主退出、超时、取消或 runner 退出时都会终止或关闭 Job；根进程正常退出时也会关闭 Job，先清理残留 Job 成员，再把管道读到 EOF。

一次 `Shell` 调用只有一个根命令，但允许 `git`、`bun`、编译器等创建正常的子进程树。Bun runtime 使用 workspace 子树写锁、sandbox 进程写锁和全局 opaque 写屏障，因此当前单进程版本一次只执行一个 `Shell` 调用。普通工具共享 opaque 读屏障；持锁后会重新解析 realpath/File ID，资源身份变化时释放并重试。

## 安全边界

### 文件与配置完整性

- 读取沿用当前 Windows 用户权限，设计上近似全盘可读。
- `workspace_write` restricted token 的本地文件系统写入只允许固定 workspace；本次临时 profile 也位于 workspace 内。workspace 根目录项本身不能被沙箱删除或重命名。
- `danger_full_access` 不提供文件系统写隔离：命令可按当前宿主用户权限读取或修改 workspace 外文件。该模式只保留可信启动路径、句柄白名单、Job 生命周期、超时和输出上限，不应称为文件系统沙箱。
- `workspace_write` 会对 workspace 根级现存的 `.cagent`、`.mcp.json`、`AGENTS.md`、`CLAUDE.md`、`.env*` 设置 deny-write/delete。普通 `.git` 目录对象不能被重命名/删除，现存 `config` 与 `hooks` 受完整写保护，同时保留 index/object/ref 写入；worktree 的 `.git` gitfile 整体保护。`danger_full_access` 不安装也不受这些 capability deny ACE 约束。
- 在 `workspace_write` 下，敏感路径若为 reparse point，runner fail closed。NTFS 无法为尚不存在的任意 `.env.*` 名称预设文件 ACE，因此这项保护只覆盖命令启动前已经存在的匹配项。
- `workspace_write` 的 capability ACL 是宿主上的持久元数据，不会随命令回滚。相同规范化路径使用稳定 SID，重复执行不会持续追加相同 ACE；目录改名或对象被外部进程移动后，旧 ACE 仍需按持久 ACL 对待。
- 稳定 SID 也意味着对象漂移边界：若沙箱外、具有宿主权限的进程把带 capability ACE 的对象移出 workspace，后续同 workspace 的 restricted token 仍可能写该对象。M1 没有安全撤销任意外移 ACE 的机制；要消除该缺口，需要每次运行的随机 capability 与可靠回收、broker/minifilter，或更强的系统隔离。
- Windows 会把新增的可继承 ACE 自动传播到现有子对象。runner 每次启动都识别链接计数大于 1 的普通文件，并为 workspace capability SID 明确拒绝写数据、追加、写 attributes/EA 和删除权限；拒绝掩码不会包含与 `FILE_GENERIC_READ` 重叠的标准权限，因此沙箱仍可读取这类文件。该 ACE 同样作用于文件的其他硬链接别名，但只约束本 workspace 的合成 SID，不改变宿主用户自身权限。首次安装 allow ACE 时仍拒绝任意已有 reparse point，避免首次自动传播沿特殊路径越界；根 ACE 已存在后的扫描不会跟随 reparse point。
- reparse/hardlink 扫描到 `SetNamedSecurityInfoW` 之间仍有路径式 TOCTOU。M1 的威胁模型假设没有并发的对抗性宿主进程修改 workspace；若以后把外部并发攻击者纳入边界，应改为 handle-relative 操作并核验 File ID。
- 默认 helper 位于 workspace 外。若错误地把 runner 放进某个写根，原生端还会保护自身文件及父目录，阻止下一次调用被替换。

Shell 的文件修改直接落在宿主文件系统；M1 没有快照、copy-on-write 或自动回滚。`workspace_write` 把可写范围收敛到 workspace，`danger_full_access` 则没有这个范围限制。

### 进程生命周期

- 目标由创建属性原子加入 Job，并保持 suspended 直到成员资格复验完成；任何安全步骤失败都拒绝运行，不会降级到普通 `spawn`。
- 句柄继承采用显式白名单；Job 使用 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。
- Job UI restrictions 阻止跨 Job USER handle、剪贴板读写、desktop 创建/切换、global atom、显示/系统参数修改与 `ExitWindows`。
- Job 只覆盖成功加入它的进程。经 WMI/CIM、计划任务或其他系统 broker 创建的进程可能不继承调用方 Job，并可能在 Shell 返回后继续运行；M1 对这些 Job 外进程不提供生命周期隔离。
- 输出按总字节预算持续排空，防止管道死锁；协议与 helper stderr 也有独立上限。
- M1 未设置 CPU、内存或磁盘配额。
- `workspace_write` 正常栈展开会 best-effort 清理临时 profile；若 helper 被强杀，可能遗留 workspace 内的 `.cagent-sandbox/profiles/*`，后续可人工清理。`danger_full_access` 不创建临时 profile。

### 网络与保密性

两种模式都**不隔离网络**。`workspace_write` 返回 `enforcement.network = inherited_not_isolated`；`danger_full_access` 返回 `inherited_unrestricted`，明确表示命令继承宿主网络能力。restricted token 无法可靠阻止 Winsock 出站连接。

M1 也不是保密边界：目标仍可读取当前用户有权读取的文件、部分注册表/进程状态。Job UI restrictions 限制了常见 UI shatter 与剪贴板路径，但目标仍运行在默认 desktop，没有私有 desktop 或完整 GUI/凭据保险库隔离。`workspace_write` 的环境白名单只防止凭据被直接继承；`danger_full_access` 会使用控制面提交的完整宿主环境。两者都不能替代独立账户、AppContainer 或 WFP。不要把 M1 描述成“断网”或“可安全运行任意恶意程序”的沙箱。

## Agent 集成边界

- `Shell` 只注册在 Windows 主 Agent 的普通、无额外 write policy 模式；plan、memory 与所有 sub-agent 都拿不到它。
- Read、Write、Edit、Glob、Grep 等现有工具仍在可信 Bun 主进程中执行，不经过 runner。原生敏感路径 deny ACE 只约束 restricted token，因此不会阻止这些宿主工具按其自身权限修改文件。
- Shell 造成的文件变化暂不写入 Agent 的 `changedFiles`。
- M1 当前只支持单 Bun 进程内的锁与队列，不提供跨进程协调。
- 初始 workspace 是信任基线。`workspace_write` runner 会在首次 Shell 前实体化并保护 `.cagent`，但不会证明仓库初始内容可信；workspace MCP 配置也应只用于可信仓库。
- 正式部署时，Bun 控制面、runner 和启动配置应安装在目标 workspace 外，并禁用目标仓库对 dotenv、preload 等启动行为的影响；源码自托管模式不是跨重启完整性边界。
- 当前 `bin/cagent` 仅关闭 dotenv 自动加载，不能阻止目标 workspace 的 `bunfig.toml` preload 在入口前执行。正式发行应使用 Bun 的 `--no-compile-autoload-dotenv --no-compile-autoload-bunfig` 构建 standalone executable，或使用等价的可信原生启动器。

## 协议

runner 从 stdin 读取不超过 1 MiB 的单个 JSON 请求，并向 stdout 写一个 JSON 响应。协议版本为 `3`。

请求字段：`version`、`request_id`、`parent_pid`、`execution_mode`、`args`、`cwd`、`writable_roots`、`env`、`timeout_ms`、`max_output_bytes`。`execution_mode` 可取 `workspace_write` 或 `danger_full_access`；缺省时按 `workspace_write` 处理。`parent_pid` 必须是仍存活且不同于 runner 的宿主进程；客户端不能指定 executable，目标由执行流程第 1 步在命令启动前解析。

响应包含 `status`、退出码、stdout/stderr、超时与截断标记、结构化 Windows 错误、协议声明的 enforcement 模式，以及实际选用的 `shell`。成功响应的 `shell` 为 `{engine:"pwsh",version:"7",fallback:false}` 或 `{engine:"windows_powershell",version:"5.1",fallback:true}`，错误响应则为 `null`；`fallback` 表示命令启动前选择了兼容引擎，并不表示失败后重跑。错误响应也会声明目标模式，它不表示失败前所有 enforcement 步骤都已实际施加。未知字段、版本不匹配，以及当前执行模式所需的路径或 ACL 校验失败都会 fail closed。

## 借鉴与后续

cc-haha 提供了“启动时建立策略、allow 内再 deny 高风险配置、失败不静默降级”的集成思路；原生执行边界主要参考 Codex Windows runner 的 restricted token、路径 capability SID、ACL 与句柄白名单设计。本实现额外使用创建属性让目标原子进入 Job，并在恢复目标线程前复验成员资格。

后续若需要保密性和可靠断网，应增加受保护的独立 Windows 账户与 WFP，或在兼容性验证后引入 AppContainer；不能用代理环境变量冒充网络隔离。
