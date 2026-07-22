# Coding Agent 模型请求与 Prompt 注入

## 核心结论

Coding Agent 发给模型的不是单一 Prompt 字符串，而是一个完整请求：

```text
ModelRequest
├─ messages
│  ├─ system：安全边界、项目指令、运行时提醒
│  ├─ user/agent：用户任务与 Agent 协作消息
│  ├─ assistant：历史回复与工具调用
│  └─ tool：工具执行结果
└─ toolSpecs：当前允许调用的工具名称、描述和参数 Schema
```

本项目每轮按以下顺序组装上下文：

1. 基础 System Prompt；
2. Agent 消息安全提醒（条件注入）；
3. Plan Mode 提醒和当前计划（条件注入）；
4. Memory 索引与相关 Memory（存在且命中时注入）；
5. 已被压缩的历史工具执行摘要（需要时注入）；
6. 当前会话历史，包括用户消息、模型回复、工具调用和工具结果；
7. 独立于消息的 Tool Specs。

## 哪些必须注入

### 协议层必须

- **当前用户任务或等价摘要**：否则模型不知道要完成什么。
- **合法的工具调用消息对**：保留 Tool Result 时，必须同时保留对应的 Assistant Tool Call 和 `tool_call_id`，否则 API 可能拒绝请求。
- **需要模型调用的工具 Schema**：普通对话可以没有工具；要执行工具，就必须提供工具名称、说明和参数结构。

### 产品与安全层必须

- **基础 System Prompt**：规定 workspace 边界、敏感文件保护、项目指令优先级和最终交付要求。API 不强制，但 Coding Agent 的安全运行需要它。
- **近期对话或可信压缩摘要**：不必永久保留全部原文，但必须保留目标、约束、已完成工作和未解决事项。
- **Plan Mode 提醒**：仅在 Plan Mode 下必须，配合控制面的工具过滤，防止模型在规划阶段产生副作用。
- **Agent 消息安全提醒**：出现 Sub-agent 或 Mailbox 内容时必须，避免把不可信的同级 Agent 输出提升为系统指令。
- **项目指令**：`AGENTS.md` 或 `CLAUDE.md` 存在且通过安全校验时属于条件性必须；不存在时不影响 Agent 启动。

## 哪些不是必须注入

- **长期 Memory**：用于跨会话偏好和项目知识，加载失败时单次任务仍可继续。
- **相关 Memory 正文**：属于效果增强，而且检索选择可能额外调用一次模型。
- **完整原始历史**：长会话可把早期消息压缩成摘要，只保留最近几轮原文。
- **历史工具执行摘要**：主要用于压缩后避免重复操作；原始工具消息仍在时不需要重复注入。
- **全部 Todo 和权限内部状态**：权限应由控制面强制执行，不能只依赖 Prompt；模型只需看到当前可用工具和必要的模式提示。

## 为什么权限不能只写在 Prompt 里

Prompt 只能影响模型行为，不能形成可靠的安全边界。正确流程是：

```text
模型发起工具调用
→ 控制面检查模式和权限
→ 必要时请求用户审批
→ 持锁后重新校验资源边界
→ 执行工具
→ 将结果返回模型
```

因此，System Prompt 中的“不要修改文件”是行为提示；工具过滤、路径校验、Sandbox 和审批状态机才是实际约束。

## Token 优化思路

- 保留精简且稳定的基础 System Prompt；
- 只发送当前模式下可用的 Tool Specs；
- 保留近期对话，将早期历史压缩为可信摘要；
- Memory 按需检索，不要注入全部正文；
- 缓存同一用户任务的 Memory 选择结果，避免每轮重复调用模型；
- 工具历史只保留目标、状态和失败类型，不重复注入大段原始输出。

## 30 秒面试回答

Coding Agent 的模型输入通常由消息上下文和工具定义两部分组成。消息中包含基础 System Prompt、用户任务、必要的会话历史，以及按场景注入的 Plan、项目指令和 Memory；工具定义则描述当前允许调用的工具及参数 Schema。真正必须保留的是用户目标、安全边界、近期上下文，以及合法配对的工具调用和结果。长期 Memory、完整历史和工具摘要属于可选增强，可以通过按需检索和上下文压缩降低 Token。权限不能只依赖 Prompt，必须由控制面的审批、工具过滤、路径校验和 Sandbox 强制执行。

## 项目中的对应实现

- 主请求组装：`src/query.ts` 的 `buildModelMessages`
- 基础 Prompt 与项目指令：`src/projectContext.ts` 的 `buildBaseSystemPrompt`
- Plan Mode 提醒：`src/plan.ts` 的 `getPlanModeReminder`
- Memory 检索：`src/query.ts` 的 `loadRelevantMemoriesPrompt`
- 工具 Schema：`src/tools/types.ts` 的 `toToolSpecs`
- 上下文压缩：`src/compact.ts` 的 `autoCompactIfNeeded`
- OpenAI-compatible 消息转换：`src/model/deepseek.ts`
