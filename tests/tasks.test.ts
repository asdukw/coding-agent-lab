import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectDescendants,
	createEmptyTaskGraph,
	createTaskGraphBatch,
	PersistentTaskStore,
	validateTaskGraph,
} from "../src/tasks";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("task graph", () => {
	test("creates a valid DAG with consistent forward and reverse edges", () => {
		const result = createTaskGraphBatch(createEmptyTaskGraph(), [
			{ clientId: "analyze", subject: "Analyze", blockedBy: [] },
			{
				clientId: "implement",
				subject: "Implement",
				blockedBy: ["analyze"],
			},
		]);
		const analyze = result.tasks[0];
		const implement = result.tasks[1];
		if (!analyze || !implement) {
			throw new Error("expected both tasks");
		}

		expect(implement.blockedBy).toEqual([analyze.id]);
		expect(analyze.blocks).toEqual([implement.id]);
		expect(validateTaskGraph(result.graph)).toEqual({ valid: true });
	});

	test("rejects cyclic creation without mutating the source graph", () => {
		const original = createEmptyTaskGraph();
		expect(() =>
			createTaskGraphBatch(original, [
				{ clientId: "a", subject: "A", blockedBy: ["b"] },
				{ clientId: "b", subject: "B", blockedBy: ["a"] },
			]),
		).toThrow("dependency_cycle");
		expect(original).toEqual(createEmptyTaskGraph());
	});

	test("collects descendants without walking upward to blockers", () => {
		const result = createTaskGraphBatch(createEmptyTaskGraph(), [
			{ clientId: "root", subject: "Root", blockedBy: [] },
			{ clientId: "child", subject: "Child", blockedBy: ["root"] },
			{ clientId: "leaf", subject: "Leaf", blockedBy: ["child"] },
		]);
		const root = result.tasks[0];
		const child = result.tasks[1];
		const leaf = result.tasks[2];
		if (!root || !child || !leaf) {
			throw new Error("expected root, child, and leaf tasks");
		}

		expect(collectDescendants(root.id, result.graph.tasks)).toEqual([
			child.id,
			leaf.id,
		]);
		expect(collectDescendants(child.id, result.graph.tasks)).not.toContain(
			root.id,
		);
	});
});

describe("persistent task store", () => {
	test("atomically reserves a ready task and rejects a second owner", async () => {
		const store = await createStore();
		const [task] = await store.createBatch([
			{ clientId: "work", subject: "Work", blockedBy: [] },
		]);
		if (!task) {
			throw new Error("expected a task");
		}
		const first = await store.reserve({
			taskId: task.id,
			agentId: "agent-a",
			runId: "00000000-0000-4000-8000-000000000001",
		});
		const second = await store.reserve({
			taskId: task.id,
			agentId: "agent-b",
			runId: "00000000-0000-4000-8000-000000000002",
		});

		expect(first?.ownerAgentId).toBe("agent-a");
		expect(second).toBeUndefined();
	});

	test("rejects a late result after run ownership changes", async () => {
		const store = await createStore();
		const [task] = await store.createBatch([
			{ clientId: "work", subject: "Work", blockedBy: [], maxAttempts: 2 },
		]);
		if (!task) {
			throw new Error("expected a task");
		}
		const oldRunId = "00000000-0000-4000-8000-000000000001";
		await store.reserve({
			taskId: task.id,
			agentId: "old-agent",
			runId: oldRunId,
		});
		await store.releaseSpawnFailure({
			taskId: task.id,
			agentId: "old-agent",
			runId: oldRunId,
			error: "lost",
		});
		await store.reserve({
			taskId: task.id,
			agentId: "new-agent",
			runId: "00000000-0000-4000-8000-000000000002",
		});

		const late = await store.settleAgentRun({
			taskId: task.id,
			agentId: "old-agent",
			runId: oldRunId,
			result: { status: "completed", summary: "late result" },
		});

		expect(late.applied).toBe(false);
		expect((await store.get(task.id))?.ownerAgentId).toBe("new-agent");
	});

	test("cancels a root and descendants while returning active bindings", async () => {
		const store = await createStore();
		const [root, child] = await store.createBatch([
			{ clientId: "root", subject: "Root", blockedBy: [] },
			{ clientId: "child", subject: "Child", blockedBy: ["root"] },
		]);
		if (!root || !child) {
			throw new Error("expected root and child");
		}
		await store.reserve({
			taskId: root.id,
			agentId: "agent-root",
			runId: "00000000-0000-4000-8000-000000000001",
		});
		const running = await store.get(root.id);
		if (!running) {
			throw new Error("expected the running task");
		}
		const outcome = await store.update(
			{
				taskId: root.id,
				action: "cancel",
				expectedVersion: running.version,
				idempotencyKey: "cancel-root",
				reason: "user cancelled",
				cascade: true,
			},
			{ agentId: "main", isRoot: true },
		);

		expect(outcome.cancelledBindings).toEqual([
			{
				agentId: "agent-root",
				runId: "00000000-0000-4000-8000-000000000001",
				taskId: root.id,
			},
		]);
		expect((await store.get(root.id))?.status).toBe("cancelled");
		expect((await store.get(child.id))?.status).toBe("cancelled");
	});
});

async function createStore(): Promise<PersistentTaskStore> {
	const directory = await mkdtemp(join(tmpdir(), "cagent-task-store-"));
	temporaryDirectories.push(directory);
	return new PersistentTaskStore(directory, "test-session");
}
