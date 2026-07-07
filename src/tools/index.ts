import { editTool } from "./editTool";
import { globTool } from "./globTool";
import { grepTool } from "./grepTool";
import {
	editPlanTool,
	enterPlanModeTool,
	exitPlanModeTool,
	writePlanTool,
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
	writePlanTool,
	editPlanTool,
	exitPlanModeTool,
];

export {
	editPlanTool,
	editTool,
	enterPlanModeTool,
	exitPlanModeTool,
	globTool,
	grepTool,
	readTool,
	writePlanTool,
	writeTool,
};
