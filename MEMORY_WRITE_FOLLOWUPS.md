# Memory 写入层后续计划

状态：P0、P1 与 P2 只读 Memory Doctor 已完成；下一阶段为需要显式确认的修复/quarantine，以及失败抽取重试能力。

## P0：明确并收紧本地文件系统攻击模型

状态：已完成，见 [`docs/adr/0003-memory-filesystem-threat-model.md`](docs/adr/0003-memory-filesystem-threat-model.md)。当前版本抵御不可信模型路径与静态链接别名，并明确不承诺抵御同一宿主用户恶意进程的强 TOCTOU 竞争。

- 决定是否需要抵御另一个不受控本地进程在每次路径校验后立即 rename/junction 替换目录或已打开临时文件。
- 若需要，采用原生 `openat`/`O_NOFOLLOW`/目录句柄（Windows 使用不允许 delete-share 的文件句柄）实现，而不是依赖路径字符串的重复校验。
- 验收：对抗测试在每个 I/O 边界替换目录时，memory payload 不会出现在 memory 根目录之外。

## P1：完成 memory Edit 的事务语义

状态：已完成。读取、定位替换、校验、原子写入和索引刷新现处于同一 mutation lock 内；提交前会比较 device、inode、size、mtime 和内容快照，并以 `MemoryEditConflictError` 报告冲突。

- 将“读取旧内容、定位替换、frontmatter/去重校验、原子写入、索引刷新”纳入同一 memory mutation lock。
- 为 Edit 增加版本或 inode/mtime 冲突检测，避免两个并发编辑以旧内容互相覆盖。
- 验收：并发 Edit 对同一 topic 时，一个操作成功，另一个得到可追踪的冲突错误；`MEMORY.md` 保持最新。

## P1：补齐跨进程锁的专项测试

状态：已完成。专项测试覆盖并发 Edit、相同 description、容量上限、目录与 Windows 大小写别名、持锁进程异常退出；锁库会在取得事务后执行 `PRAGMA quick_check`，损坏时 fail-closed 且不修改 topic 或索引。

- 用独立 Bun 进程验证 SQLite `BEGIN IMMEDIATE` 互斥、进程异常退出后的自动释放以及锁库损坏时 fail-closed。
- 覆盖工作目录别名、多个 cagent 进程和容量上限竞争。
- 验收：多进程写同一 description 时最多一个 topic 落盘，崩溃后下一进程可继续写入。

## P2：加强重复与存量治理

状态：只读扫描已完成。`--memory-check` 以稳定问题代码报告 frontmatter、大小、可读性、精确重复、过期状态和索引漂移，且不会创建或修改 Memory Store；近义 fingerprint、安全修复和 quarantine 仍待实现。

- 在现有 description/body 精确去重之外，增加可解释的主题 fingerprint 或“候选 topic 必须先 Read”的强制记录，减少近义重复。
- 提供存量扫描/迁移命令：列出失效 frontmatter、过大文件、重复 topic 和可重建索引；支持安全修复或 quarantine。
- 验收：迁移前后可审计，旧文件问题不会被静默忽略。

## P2：让失败处理可操作

- 增加本地命令或界面入口查看最近 memory extraction 的结果、失败原因和关联 session。
- 允许在用户确认后重试失败抽取，并记录重试链路。
- 验收：无需直接翻 JSONL 即可定位失败并安全重试。

## 后续执行顺序

1. 基于 Memory Doctor 的结构化结果，增加显式确认后的安全修复与 quarantine。
2. 增加 Memory Extraction 失败查看和重试入口，并复用相同审计格式。
