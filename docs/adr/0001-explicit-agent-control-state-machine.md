# ADR 0001：显式 Agent 控制与审批状态机

- 状态：已采纳
- 日期：2026-07-20

## 背景

模型输出可能包含文件修改、外部工具调用或进程启动。仅依赖 Prompt 约束，无法为副作用提供稳定、可测试的授权边界；计划是否合理与某次危险操作是否允许，也是两个不同问题。

## 决策

采用可信控制面驱动的显式状态机：

1. [`src/query.ts`](../../src/query.ts) 负责 Agent Loop，模型只能返回文本或结构化工具调用。
2. [`src/plan.ts`](../../src/plan.ts) 管理计划状态；计划获批只允许进入执行阶段。
3. [`src/tools/permissions.ts`](../../src/tools/permissions.ts) 独立判断危险工具调用，区分单批次允许、当前进程允许和拒绝。
4. [`src/tools/runner.ts`](../../src/tools/runner.ts) 在资源协调后执行工具，并保留重新校验边界。
5. 进程级授权不写入 Session；恢复的待审批调用必须重新验证，不能继承旧进程的权限。

## 备选方案

- **仅用系统 Prompt 禁止危险行为**：实现简单，但授权边界不可验证，也无法抵御错误或恶意工具调用。
- **先执行、后审计**：可以保留轨迹，但不能阻止不可逆副作用。
- **每个工具自行实现审批**：会造成语义分散，难以统一恢复与批量审批行为。

## 后果

- 优点：计划与副作用解耦；授权生命周期明确；状态可持久化、测试和解释。
- 代价：Agent Loop 需要处理更多暂停与恢复状态；新增危险工具必须接入统一权限和资源模型。
- 限制：控制面只能约束已注册工具；外部 MCP Server 自身仍可能产生 sandbox 之外的副作用。

## 证据

- [`tests/planMode.test.ts`](../../tests/planMode.test.ts)
- [`tests/permissionApproval.test.ts`](../../tests/permissionApproval.test.ts)
- [`tests/query.tool.test.ts`](../../tests/query.tool.test.ts)
