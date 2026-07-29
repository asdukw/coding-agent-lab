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
import { shellTool } from "./shellTool";
import {
	TASK_TOOLS,
	taskClaimTool,
	taskCreateTool,
	taskGetTool,
	taskListTool,
	taskUpdateTool,
} from "./taskTools";
import type { Tools } from "./types";
import { writeTool } from "./writeTool";

const WINDOWS_TOOLS: Tools = process.platform === "win32" ? [shellTool] : [];

export const BUILTIN_TOOLS: Tools = [
	readTool,
	writeTool,
	editTool,
	globTool,
	grepTool,
	...WINDOWS_TOOLS,
	enterPlanModeTool,
	updatePlanTool,
	exitPlanModeTool,
	...TASK_TOOLS,
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
	shellTool,
	spawnSubagentTool,
	taskClaimTool,
	taskCreateTool,
	taskGetTool,
	taskListTool,
	taskUpdateTool,
	updatePlanTool,
	waitAgentTool,
	writeTool,
};
