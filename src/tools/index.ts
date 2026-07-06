import { editTool } from "./editTool";
import { globTool } from "./globTool";
import { grepTool } from "./grepTool";
import { readTool } from "./readTool";
import type { Tools } from "./types";
import { writeTool } from "./writeTool";

export const BUILTIN_TOOLS: Tools = [
	readTool,
	writeTool,
	editTool,
	globTool,
	grepTool,
];

export { editTool, globTool, grepTool, readTool, writeTool };
