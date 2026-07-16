export const AGENT_KINDS = [
	"main",
	"memory",
	"general-purpose",
	"explore",
	"plan",
	"verify",
] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

export type AgentIdentity = {
	id: string;
	parentId?: string;
	name?: string;
	type: AgentKind;
	depth: number;
};
