# Offline Demo Report

**PASS** — `plan-edit-session-resume` v1

> This is a checked-in, redacted snapshot from a real `bun run demo:offline` execution. Platform and duration describe that capture; the scenario assertions and trace are deterministic.
>
> The demo uses the real query loop, approval state machine, file tools, and Session Store. It intentionally exposes no Shell tool and does not exercise the Windows native sandbox.

## Summary

| Field | Value |
| --- | --- |
| Platform | win32 |
| Bun | 1.3.14 |
| Duration | 1749 ms |
| Model requests | 10 |
| Tool calls | 8 |
| Approvals | 1 plan / 1 tool |
| Session restores | 3 |
| Changed files | src/price.ts |

## Trace

- Terminals: plan_approval → tool_approval → complete → complete
- Tools: EnterPlanMode → Read → UpdatePlan → ExitPlanMode → Read → Edit → Read → Read
- Model phases: enter_plan → plan_read → update_plan → exit_plan → implementation_read → edit → verification_read → complete → resume_read → resume_complete

## Checks

- PASS: fixture contains exactly one broken expression
- PASS: demo tool surface excludes Shell and MCP
- PASS: query pauses for plan approval
- PASS: plan-boundary restore preserves the persistence cursor
- PASS: pending plan approval survives save and load
- PASS: restored session keeps its stable identity
- PASS: query pauses for one Edit approval
- PASS: approved Edit completes the first task
- PASS: workspace file contains the expected fix
- PASS: completed-session restore preserves the persistence cursor
- PASS: completed transcript restores its answer and changed file
- PASS: restored session accepts a real follow-up query
- PASS: final restore preserves the persistence cursor
- PASS: final restore has no pending approval
- PASS: repository fixture remains unchanged
- PASS: model follows the deterministic transcript phases
- PASS: terminal sequence covers both approvals and resume
- PASS: tool sequence uses only the bounded demo tools
- PASS: exactly one relative file is recorded as changed
- PASS: report omits temporary and repository absolute paths
