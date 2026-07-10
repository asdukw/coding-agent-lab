# Memory 写入层后续计划

状态：延后实现。当前版本已完成静态 symlink/junction/hardlink 防护、严格 frontmatter、精确去重、`MEMORY.md` 原子重建、失败审计和同/跨进程写入互斥。

## P0：明确并收紧本地文件系统攻击模型

- 决定是否需要抵御另一个不受控本地进程在每次路径校验后立即 rename/junction 替换目录或已打开临时文件。
- 若需要，采用原生 `openat`/`O_NOFOLLOW`/目录句柄（Windows 使用不允许 delete-share 的文件句柄）实现，而不是依赖路径字符串的重复校验。
- 验收：对抗测试在每个 I/O 边界替换目录时，memory payload 不会出现在 memory 根目录之外。

## P1：完成 memory Edit 的事务语义

- 将“读取旧内容、定位替换、frontmatter/去重校验、原子写入、索引刷新”纳入同一 memory mutation lock。
- 为 Edit 增加版本或 inode/mtime 冲突检测，避免两个并发编辑以旧内容互相覆盖。
- 验收：并发 Edit 对同一 topic 时，一个操作成功，另一个得到可追踪的冲突错误；`MEMORY.md` 保持最新。

## P1：补齐跨进程锁的专项测试

- 用独立 Bun 进程验证 SQLite `BEGIN IMMEDIATE` 互斥、进程异常退出后的自动释放以及锁库损坏时 fail-closed。
- 覆盖工作目录别名、多个 cagent 进程和容量上限竞争。
- 验收：多进程写同一 description 时最多一个 topic 落盘，崩溃后下一进程可继续写入。

## P2：加强重复与存量治理

- 在现有 description/body 精确去重之外，增加可解释的主题 fingerprint 或“候选 topic 必须先 Read”的强制记录，减少近义重复。
- 提供存量扫描/迁移命令：列出失效 frontmatter、过大文件、重复 topic 和可重建索引；支持安全修复或 quarantine。
- 验收：迁移前后可审计，旧文件问题不会被静默忽略。

## P2：让失败处理可操作

- 增加本地命令或界面入口查看最近 memory extraction 的结果、失败原因和关联 session。
- 允许在用户确认后重试失败抽取，并记录重试链路。
- 验收：无需直接翻 JSONL 即可定位失败并安全重试。

## 建议执行顺序

1. 先确认 P0 的威胁模型；这决定是否需要原生文件句柄实现。
2. 实现 P1 的事务 Edit 与多进程测试。
3. 增加 P2 的扫描、迁移和可视化重试能力。
