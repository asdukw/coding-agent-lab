import { describe, expect, test } from "bun:test";
import {
	claimTask,
	createEmptyTaskGraph,
	createTaskGraphBatch,
	recoverExpiredLeases,
	updateTaskGraph,
	validateTaskGraph,
} from "../src/tasks";

describe("task graph", () => {
	test("creates a valid DAG atomically", () => {
		const result = createTaskGraphBatch(createEmptyTaskGraph(), [
			{ clientId: "analyze", subject: "Analyze", blockedBy: [] },
			{
				clientId: "implement",
				subject: "Implement",
				blockedBy: ["analyze"],
			},
		]);

		const analyzeTask = result.tasks[0];
		if (!analyzeTask) {
			throw new Error("expected the analyze task to be created");
		}
		expect(result.tasks[1]?.blockedBy).toEqual([analyzeTask.id]);
		expect(validateTaskGraph(result.graph)).toEqual({ valid: true });
	});

	test("rejects a cycle in a batch without mutating the original graph", () => {
		const original = createEmptyTaskGraph();

		expect(() =>
			createTaskGraphBatch(original, [
				{ clientId: "a", subject: "A", blockedBy: ["b"] },
				{ clientId: "b", subject: "B", blockedBy: ["a"] },
			]),
		).toThrow("dependency_cycle");
		expect(original).toEqual(createEmptyTaskGraph());
	});

	test("rejects an incremental dependency cycle", () => {
		const initial = createTaskGraphBatch(createEmptyTaskGraph(), [
			{ clientId: "a", subject: "A", blockedBy: [] },
			{ clientId: "b", subject: "B", blockedBy: ["a"] },
		]);
		const [a] = initial.tasks;

		expect(() =>
			updateTaskGraph(initial.graph, {
				taskId: a?.id ?? "",
				action: "add_dependencies",
				blockedBy: [initial.tasks[1]?.id ?? ""],
				expectedVersion: a?.version ?? 0,
				idempotencyKey: "cycle-attempt",
			}),
		).toThrow("dependency_cycle");
		expect(validateTaskGraph(initial.graph)).toEqual({ valid: true });
	});

	test("enforces readiness, lease ownership, version, and idempotency", () => {
		const initial = createTaskGraphBatch(createEmptyTaskGraph(), [
			{ clientId: "a", subject: "A", blockedBy: [] },
			{ clientId: "b", subject: "B", blockedBy: ["a"] },
		]);
		const [a, b] = initial.tasks;
		expect(() =>
			claimTask(initial.graph, b?.id ?? "", "worker", 60_000),
		).toThrow("blocked by");

		const claimed = claimTask(initial.graph, a?.id ?? "", "worker", 60_000);
		const completed = updateTaskGraph(claimed.graph, {
			taskId: claimed.task.id,
			action: "complete",
			expectedVersion: claimed.task.version,
			idempotencyKey: "complete-a",
			agentId: "worker",
			leaseToken: claimed.task.lease?.token,
			result: { summary: "done" },
		});
		const replay = updateTaskGraph(completed.graph, {
			taskId: claimed.task.id,
			action: "complete",
			expectedVersion: claimed.task.version,
			idempotencyKey: "complete-a",
			agentId: "worker",
			leaseToken: claimed.task.lease?.token,
		});

		expect(replay.idempotentReplay).toBe(true);
		expect(
			claimTask(completed.graph, b?.id ?? "", "worker-2", 60_000).task.status,
		).toBe("running");
	});

	test("recovers an expired lease for deterministic rescheduling", () => {
		const initial = createTaskGraphBatch(createEmptyTaskGraph(), [
			{ clientId: "work", subject: "Work", blockedBy: [] },
		]);
		const now = new Date("2026-07-30T00:00:00.000Z");
		const claimed = claimTask(
			initial.graph,
			initial.tasks[0]?.id ?? "",
			"lost-agent",
			1_000,
			now,
		);
		const recovered = recoverExpiredLeases(
			claimed.graph,
			new Date(now.getTime() + 1_001),
		);

		expect(recovered.recoveredTaskIds).toEqual([claimed.task.id]);
		expect(recovered.graph.tasks[claimed.task.id]?.status).toBe("pending");
		expect(recovered.graph.tasks[claimed.task.id]?.owner).toBeUndefined();
		expect(recovered.graph.tasks[claimed.task.id]?.version).toBe(
			claimed.task.version + 1,
		);
	});
});
