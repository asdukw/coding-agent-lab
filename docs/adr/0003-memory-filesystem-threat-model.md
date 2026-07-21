# ADR 0003：Memory 文件系统威胁模型

- 状态：已采纳
- 日期：2026-07-21

## 背景

模型与项目指令可以选择 Memory 工具参数，但不能被信任。Memory 写入层因此需要阻止路径逃逸、链接别名绕过、格式破坏和并发丢失更新。另一方面，若把同一宿主用户控制的任意进程也视为持续对手，仅靠 Bun 中反复校验路径字符串，无法消除校验与 I/O 之间的 TOCTOU 窗口。

## 决策

当前版本采用以下边界：

1. 模型输出、项目指令和工具参数不可信；所有 Memory 目标必须经过 workspace 包含性、规范路径、symlink/junction 和 hardlink 检查。
2. 多个正常运行的 cagent 进程属于协作方；它们通过 SQLite `BEGIN IMMEDIATE` 串行化 Memory mutation，并在取得事务后以 `PRAGMA quick_check` 验证锁库，损坏时 fail-closed。
3. Memory Edit 的读取、精确替换、frontmatter/去重校验、原子写入和索引刷新必须处于同一 mutation lock 内，并在提交前比较文件 device、inode、size、mtime 与内容快照。
4. 同一宿主用户控制的恶意进程若在路径校验后持续执行 rename、junction 替换或句柄级竞争，属于当前版本明确不抵御的攻击者。
5. 若未来需要扩大到第 4 类攻击者，必须引入基于目录/文件句柄的原生实现：Unix 使用 `openat`/`O_NOFOLLOW`，Windows 使用受约束的目录句柄和不允许 delete-share 的目标句柄；不能继续叠加路径字符串检查并宣称已经消除竞态。

## 备选方案

- **立即实现全平台原生句柄层**：能收紧 TOCTOU 边界，但显著扩大 FFI、平台测试和发布维护成本，超出当前学习项目的威胁模型。
- **只依赖进程内资源锁**：无法协调多个 cagent 进程，旧内容仍可能覆盖新内容。
- **只比较 mtime**：在时间精度较低或同尺寸替换时证据不足，因此同时比较身份、大小和内容。

## 后果

- 优点：不可信模型无法直接绕过 Memory 路径与格式边界；协作进程的编辑具有事务语义；非协作修改会尽可能转化为明确冲突。
- 代价：每次 Edit 提交前需要再次读取目标文件；SQLite 锁等待会增加少量延迟。
- 限制：提交前最后一次快照检查与原子 rename 之间仍存在宿主恶意进程可利用的窗口，本项目不会把它描述为强对抗隔离。

## 证据

- [`src/memory.ts`](../../src/memory.ts)
- [`tests/memory.test.ts`](../../tests/memory.test.ts)
- [`tests/integration/memoryMutationLock.test.ts`](../../tests/integration/memoryMutationLock.test.ts)
- [`MEMORY_WRITE_FOLLOWUPS.md`](../../MEMORY_WRITE_FOLLOWUPS.md)
