import { expect, test } from "bun:test";
import {
	AgentMailbox,
	AgentMailboxClosedError,
	AgentMailboxReceiveAbortedError,
	type AgentMessage,
	type AgentTextMessage,
} from "../src/agents/mailbox";

function textMessage(
	id: string,
	to: string,
	content: string,
): AgentTextMessage {
	return { type: "message", id, from: "parent", to, content };
}

test("mailbox keeps independent FIFO queues per agent", () => {
	const mailbox = new AgentMailbox();
	const first = textMessage("message-1", "agent-a", "first");
	const other = textMessage("message-2", "agent-b", "other");
	const second = textMessage("message-3", "agent-a", "second");

	mailbox.send(first);
	mailbox.send(other);
	mailbox.send(second);

	expect(mailbox.hasMessages("agent-a")).toBe(true);
	expect(mailbox.hasMessages("missing-agent")).toBe(false);
	expect(mailbox.poll("agent-a")).toEqual(first);
	expect(mailbox.hasMessages("agent-a")).toBe(true);
	expect(mailbox.drain("agent-a")).toEqual([second]);
	expect(mailbox.hasMessages("agent-a")).toBe(false);
	expect(mailbox.poll("agent-a")).toBeUndefined();
	expect(mailbox.drain("agent-b")).toEqual([other]);
	expect(mailbox.hasMessages("agent-b")).toBe(false);
});

test("mailbox supports all agent message variants", () => {
	type Result = { summary: string };
	const mailbox = new AgentMailbox<AgentMessage<Result>>();
	const messages: AgentMessage<Result>[] = [
		textMessage("message", "agent", "continue"),
		{
			type: "completed",
			id: "completed",
			from: "child",
			to: "agent",
			result: { summary: "done" },
		},
		{
			type: "failed",
			id: "failed",
			from: "child",
			to: "agent",
			error: "boom",
		},
		{
			type: "cancel",
			id: "cancel",
			from: "parent",
			to: "agent",
			reason: "no longer needed",
		},
	];

	for (const message of messages) {
		mailbox.send(message);
	}

	expect(mailbox.drain("agent")).toEqual(messages);
});

test("receive consumes queued messages and resolves pending receivers in order", async () => {
	const mailbox = new AgentMailbox();
	const queued = textMessage("queued", "agent", "queued");
	mailbox.send(queued);

	await expect(mailbox.receive("agent")).resolves.toEqual(queued);

	const firstReceive = mailbox.receive("agent");
	const secondReceive = mailbox.receive("agent");
	const first = textMessage("first", "agent", "first");
	const second = textMessage("second", "agent", "second");
	mailbox.send(first);
	mailbox.send(second);

	await expect(firstReceive).resolves.toEqual(first);
	await expect(secondReceive).resolves.toEqual(second);
});

test("receive abort removes its waiter without consuming a later message", async () => {
	const mailbox = new AgentMailbox();
	const controller = new AbortController();
	const receive = mailbox.receive("agent", controller.signal);

	controller.abort();
	await expect(receive).rejects.toBeInstanceOf(AgentMailboxReceiveAbortedError);

	const later = textMessage("later", "agent", "still queued");
	mailbox.send(later);
	expect(mailbox.poll("agent")).toEqual(later);

	await expect(
		mailbox.receive("agent", AbortSignal.abort()),
	).rejects.toBeInstanceOf(AgentMailboxReceiveAbortedError);
});

test("close rejects and cleans pending receivers", async () => {
	const mailbox = new AgentMailbox();
	const firstController = new AbortController();
	const first = mailbox.receive("agent-a", firstController.signal);
	const second = mailbox.receive("agent-b");

	mailbox.close();
	mailbox.close();
	await expect(first).rejects.toBeInstanceOf(AgentMailboxClosedError);
	await expect(second).rejects.toBeInstanceOf(AgentMailboxClosedError);

	firstController.abort();
	await expect(mailbox.receive("agent-a")).rejects.toBeInstanceOf(
		AgentMailboxClosedError,
	);
	expect(() => mailbox.send(textMessage("late", "agent-a", "late"))).toThrow(
		AgentMailboxClosedError,
	);
});

test("close preserves already queued messages for final draining", async () => {
	const mailbox = new AgentMailbox();
	const queued = textMessage("queued", "agent", "queued");
	mailbox.send(queued);
	mailbox.close();

	await expect(mailbox.receive("agent")).resolves.toEqual(queued);
	await expect(mailbox.receive("agent")).rejects.toBeInstanceOf(
		AgentMailboxClosedError,
	);
});
