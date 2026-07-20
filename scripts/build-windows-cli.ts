import { resolve } from "node:path";

const outputPath = process.argv[2];
if (!outputPath || !resolve(outputPath).toLowerCase().endsWith(".exe")) {
	throw new Error("Usage: bun scripts/build-windows-cli.ts <absolute-output.exe>");
}

const repoRoot = resolve(import.meta.dir, "..");
const devtoolsStub = resolve(
	import.meta.dir,
	"release/reactDevtoolsCoreStub.ts",
);
const result = await Bun.build({
	entrypoints: [resolve(repoRoot, "src/cli.ts")],
	target: "bun",
	packages: "bundle",
	define: {
		"process.env.DEV": JSON.stringify("false"),
	},
	plugins: [
		{
			name: "disable-react-devtools",
			setup(builder) {
				builder.onResolve({ filter: /^react-devtools-core$/ }, () => ({
					path: devtoolsStub,
				}));
			},
		},
	],
	compile: {
		target: "bun-windows-x64",
		outfile: resolve(outputPath),
		autoloadDotenv: false,
		autoloadBunfig: false,
		autoloadTsconfig: false,
		autoloadPackageJson: false,
	},
});

if (!result.success) {
	for (const log of result.logs) {
		console.error(log);
	}
	process.exitCode = 1;
}
