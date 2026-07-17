export type AppStopProducer = () => void | Promise<void>;

export class AppLifecycle {
	private readonly tasks = new Set<Promise<void>>();
	private readonly stopProducers = new Set<AppStopProducer>();
	private readonly failures: unknown[] = [];
	private readonly abortController = new AbortController();
	private closing = false;
	private closed = false;
	private shutdownPromise: Promise<void> | undefined;

	get isClosing(): boolean {
		return this.closing;
	}

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	track<T>(task: Promise<T>): Promise<T> {
		if (this.closed) {
			throw new Error("cannot track an App task after shutdown completed");
		}

		const observed = task.then(
			() => undefined,
			(caught) => {
				this.failures.push(caught);
			},
		);
		this.tasks.add(observed);
		void observed.then(() => {
			this.tasks.delete(observed);
		});
		return task;
	}

	registerStopProducer(stop: AppStopProducer): void {
		if (this.closed) {
			throw new Error(
				"cannot register an App producer after shutdown completed",
			);
		}
		if (this.closing) {
			this.track(Promise.resolve().then(stop));
			return;
		}
		this.stopProducers.add(stop);
	}

	shutdown(): Promise<void> {
		this.shutdownPromise ??= this.performShutdown();
		return this.shutdownPromise;
	}

	private async performShutdown(): Promise<void> {
		this.closing = true;
		this.abortController.abort("App shutdown");
		const stopResults = await Promise.allSettled(
			[...this.stopProducers].map((stop) => Promise.resolve().then(stop)),
		);
		this.stopProducers.clear();
		for (const result of stopResults) {
			if (result.status === "rejected") {
				this.failures.push(result.reason);
			}
		}

		while (this.tasks.size > 0) {
			await Promise.all([...this.tasks]);
		}
		this.closed = true;

		if (this.failures.length > 0) {
			throw new AggregateError(this.failures, "App shutdown failed");
		}
	}
}

export function createAppLifecycle(): AppLifecycle {
	return new AppLifecycle();
}
