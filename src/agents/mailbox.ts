export type AgentMessageBase = {
	id: string;
	from: string;
	to: string;
};

export type AgentTextMessage = AgentMessageBase & {
	type: "message";
	content: string;
};

export type AgentCompletedMessage<TResult = unknown> = AgentMessageBase & {
	type: "completed";
	result: TResult;
};

export type AgentFailedMessage = AgentMessageBase & {
	type: "failed";
	error: string;
};

export type AgentCancelMessage = AgentMessageBase & {
	type: "cancel";
	reason?: string;
};

export type AgentMessage<TResult = unknown> =
	| AgentTextMessage
	| AgentCompletedMessage<TResult>
	| AgentFailedMessage
	| AgentCancelMessage;

type MailboxWaiter<TMessage> = {
	resolve(message: TMessage): void;
	reject(error: Error): void;
	signal?: AbortSignal;
	onAbort?: () => void;
};

export class AgentMailboxClosedError extends Error {
	constructor() {
		super("agent mailbox is closed");
		this.name = "AgentMailboxClosedError";
	}
}

export class AgentMailboxReceiveAbortedError extends Error {
	constructor() {
		super("agent mailbox receive aborted");
		this.name = "AbortError";
	}
}

/**
 * A process-local mailbox with one FIFO queue per receiving agent.
 *
 * Messages are delivered to the oldest pending receiver for `message.to`.
 * When no receiver is waiting, they remain queued until poll, drain, or receive
 * consumes them.
 */
export class AgentMailbox<TMessage extends AgentMessage = AgentMessage> {
	private readonly queues = new Map<string, TMessage[]>();
	private readonly waiters = new Map<string, MailboxWaiter<TMessage>[]>();
	private closed = false;

	send(message: TMessage): void {
		if (this.closed) {
			throw new AgentMailboxClosedError();
		}

		const waiter = this.shiftWaiter(message.to);
		if (waiter) {
			this.detachAbortListener(waiter);
			waiter.resolve(message);
			return;
		}

		const queue = this.queues.get(message.to);
		if (queue) {
			queue.push(message);
		} else {
			this.queues.set(message.to, [message]);
		}
	}

	poll(agentId: string): TMessage | undefined {
		const queue = this.queues.get(agentId);
		const message = queue?.shift();
		if (queue?.length === 0) {
			this.queues.delete(agentId);
		}
		return message;
	}

	hasMessages(agentId: string): boolean {
		return (this.queues.get(agentId)?.length ?? 0) > 0;
	}

	drain(agentId: string): TMessage[] {
		const queue = this.queues.get(agentId);
		if (!queue) {
			return [];
		}
		this.queues.delete(agentId);
		return queue;
	}

	receive(agentId: string, signal?: AbortSignal): Promise<TMessage> {
		if (signal?.aborted) {
			return Promise.reject(new AgentMailboxReceiveAbortedError());
		}

		const queued = this.poll(agentId);
		if (queued) {
			return Promise.resolve(queued);
		}

		if (this.closed) {
			return Promise.reject(new AgentMailboxClosedError());
		}

		return new Promise<TMessage>((resolve, reject) => {
			const waiter: MailboxWaiter<TMessage> = { resolve, reject, signal };
			if (signal) {
				waiter.onAbort = () => {
					if (!this.removeWaiter(agentId, waiter)) {
						return;
					}
					this.detachAbortListener(waiter);
					reject(new AgentMailboxReceiveAbortedError());
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}

			const waiters = this.waiters.get(agentId);
			if (waiters) {
				waiters.push(waiter);
			} else {
				this.waiters.set(agentId, [waiter]);
			}
		});
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;

		for (const waiters of this.waiters.values()) {
			for (const waiter of waiters) {
				this.detachAbortListener(waiter);
				waiter.reject(new AgentMailboxClosedError());
			}
		}
		this.waiters.clear();
	}

	private shiftWaiter(agentId: string): MailboxWaiter<TMessage> | undefined {
		const waiters = this.waiters.get(agentId);
		const waiter = waiters?.shift();
		if (waiters?.length === 0) {
			this.waiters.delete(agentId);
		}
		return waiter;
	}

	private removeWaiter(
		agentId: string,
		waiter: MailboxWaiter<TMessage>,
	): boolean {
		const waiters = this.waiters.get(agentId);
		if (!waiters) {
			return false;
		}
		const index = waiters.indexOf(waiter);
		if (index < 0) {
			return false;
		}
		waiters.splice(index, 1);
		if (waiters.length === 0) {
			this.waiters.delete(agentId);
		}
		return true;
	}

	private detachAbortListener(waiter: MailboxWaiter<TMessage>): void {
		if (waiter.signal && waiter.onAbort) {
			waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.onAbort = undefined;
		}
	}
}
