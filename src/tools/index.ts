import {
	AGENT_TOOLS,
	cancelAgentTool,
	listAgentsTool,
	sendAgentMessageTool,
	spawnSubagentTool,
	waitAgentTool,
} from "./agentTools";
import { editTool } from "./editTool";
import { globTool } from "./globTool";
import { grepTool } from "./grepTool";
import {
	enterPlanModeTool,
	exitPlanModeTool,
	updatePlanTool,
} from "./planTools";
import { readTool } from "./readTool";
import type { Tools } from "./types";
import { writeTool } from "./writeTool";

export const BUILTIN_TOOLS: Tools = [
	readTool,
	writeTool,
	editTool,
	globTool,
	grepTool,
	enterPlanModeTool,
	updatePlanTool,
	exitPlanModeTool,
	...AGENT_TOOLS,
];

export {
	cancelAgentTool,
	editTool,
	enterPlanModeTool,
	exitPlanModeTool,
	globTool,
	grepTool,
	listAgentsTool,
	readTool,
	sendAgentMessageTool,
	spawnSubagentTool,
	updatePlanTool,
	waitAgentTool,
	writeTool,
};
