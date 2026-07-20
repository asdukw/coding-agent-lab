import packageJson from "../package.json" with { type: "json" };

export const CAGENT_VERSION = packageJson.version;
