# ADR 0002：Auto 模式采用 sandbox-first 授权

## 状态

已接受。

## 背景

早期 `auto` 虽然自动允许 workspace 内的 `Write` 与 `Edit`，但仍在每次 Shell 调用前询问。这样能够补偿当前 Win32 runner 尚未隔离宿主读取和网络的限制，却使权限流继续围绕工具名工作，并产生与 sandbox 边界重复的审批。

目标模型是：边界内的操作默认执行，只有扩大边界时才请求用户授权。工具名称和用户可见的 `ask`、`auto`、`full_access` 预设保持不变。

## 决策

1. `auto` 下，未请求绕过 sandbox 的 Shell 调用直接以 `workspace_write` 执行。
2. Shell 通过 `dangerously_disable_sandbox: true` 显式声明需要宿主权限。该声明在进程启动前进入正常工具审批流；`full_access` 已具备宿主权限，因此不额外询问。
3. sandboxed 命令失败后，控制面不会自动以更高权限重放。模型必须分析结果并发起一条带 bypass 声明的新调用，避免重复未完成命令已经产生的副作用。
4. `allow_session` 的 Shell 授权只覆盖普通 Shell 调用，不能静默授权后续 sandbox bypass。
5. MCP 工具的外部副作用不受本地 sandbox 强制约束，继续在 `auto` 下审批。
6. 路径保护、Plan Mode、主 Agent 专属 Shell、恢复时重新校验等硬边界保持不变。

## 安全边界

当前 Windows `workspace_write` 使用 restricted token、写 ACL 和 Job Object。它限制 workspace 外写入并约束普通进程树生命周期，但不隔离宿主文件读取或网络。因此本决策对齐的是 sandbox-first 的授权状态机，而不是完整的机密性 containment。

在读取隔离与网络代理完成前，产品必须在 Shell 描述、执行结果和架构文档中披露这个限制。后续增强 sandbox enforcement 时，不需要再次改变 `auto` 的审批语义。

## 结果

- 常规构建、测试和代码搜索命令在 `auto` 下不再产生逐命令审批。
- 越界具有显式、可审计的工具参数和审批记录。
- 用户可以拒绝单次越界，而不必退出 `auto` 或切换整个 Session 到 `full_access`。
- 完整对齐 Anthropic 所述的文件读取与网络双边界仍是后续工作。

## 参考

- [Anthropic：Beyond permission prompts—making Claude Code more secure and autonomous](https://www.anthropic.com/engineering/claude-code-sandboxing)
- [Claude Code Docs：Sandboxing](https://code.claude.com/docs/en/sandboxing)
- [`NanmiCoder/cc-haha`](https://github.com/NanmiCoder/cc-haha) 的 sandbox auto-allow / explicit bypass 交互语义；本项目未复制其源码。
