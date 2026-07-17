import { expect, test } from "bun:test";
import { createAppLifecycle } from "../src/ui/appLifecycle";

test("shutdown is idempotent and drains tasks added while closing", async () => {
	const lifecycle = createAppLifecycle();
	const first = deferred<void>();
	const second = deferred<void>();
	let producerStopped = false;
	let lateProducerStopped = false;
	let shutdownSettled = false;

	lifecycle.registerStopProducer(() => {
		producerStopped = true;
	});
	lifecycle.track(
		first.promise.then(() => {
			lifecycle.track(second.promise);
		}),
	);

	const shutdown = lifecycle.shutdown();
	lifecycle.registerStopProducer(() => {
		lateProducerStopped = true;
	});
	void shutdown.then(
		() => {
			shutdownSettled = true;
		},
		() => {
			shutdownSettled = true;
		},
	);
	expect(lifecycle.shutdown()).toBe(shutdown);
	expect(lifecycle.isClosing).toBe(true);
	expect(lifecycle.signal.aborted).toBe(true);

	await nextEventLoopTurn();
	expect(producerStopped).toBe(true);
	expect(lateProducerStopped).toBe(true);
	expect(shutdownSettled).toBe(false);

	first.resolve();
	await nextEventLoopTurn();
	expect(shutdownSettled).toBe(false);

	second.resolve();
	await shutdown;
	expect(shutdownSettled).toBe(true);
	expect(() => lifecycle.track(Promise.resolve())).toThrow(
		"cannot track an App task after shutdown completed",
	);
});

test("shutdown reports failures from tracked tasks after draining", async () => {
	const lifecycle = createAppLifecycle();
	const task = deferred<void>();
	lifecycle.track(task.promise);

	const shutdown = lifecycle.shutdown();
	task.reject(new Error("background persistence failed"));

	await expect(shutdown).rejects.toThrow("App shutdown failed");
});

function deferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason: unknown): void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function nextEventLoopTurn(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}
