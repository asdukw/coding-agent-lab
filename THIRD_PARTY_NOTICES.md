# Third-Party Notices

Coding Agent Lab distributes a standalone Windows executable built with Bun
and a native Windows sandbox runner built with Rust. The tables below summarize
the bundled runtime and the project's direct runtime dependencies for v0.2.1.
The exact JavaScript and Rust dependency versions come from `bun.lock` and
`native/windows-sandbox-runner/Cargo.lock`, respectively.

This is a direct-dependency summary, not a replacement for the complete license
terms, copyright notices, or transitive-dependency notices published by each
upstream project. Follow the linked upstream license material before
redistributing the binaries or their components.

## Bundled runtime

| Component | Version | License summary | Upstream and complete terms |
| --- | --- | --- | --- |
| Bun standalone runtime | 1.3.14 | Bun itself is MIT-licensed. Bun's tagged license also documents statically linked JavaScriptCore/WebKit under LGPL-2 and additional linked libraries under their respective licenses. | [Bundled Bun v1.3.14 license](THIRD_PARTY_LICENSES/BUN-1.3.14-LICENSE.md) · [Tagged upstream copy](https://github.com/oven-sh/bun/blob/bun-v1.3.14/LICENSE.md) · [Bun source](https://github.com/oven-sh/bun/tree/bun-v1.3.14) |
| ripgrep | 15.2.0 | MIT OR Unlicense. Both upstream license texts are bundled in the Windows archive. | `THIRD_PARTY_LICENSES/RIPGREP-15.2.0-LICENSE-MIT.txt` · `THIRD_PARTY_LICENSES/RIPGREP-15.2.0-UNLICENSE.txt` · [release](https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0) · [source](https://github.com/BurntSushi/ripgrep/tree/15.2.0) |

The official release workflow pins Bun 1.3.14 and embeds the runtime through
`Bun.build({ compile: ... })` in `scripts/build-windows-cli.ts`. The repository
and Windows archive include Bun's exact tagged `LICENSE.md`, including its
runtime licensing and relinking notes.

## Direct npm runtime dependencies

These packages are declared under `dependencies` in `package.json` and are
bundled into the standalone CLI where reachable from its entry point. Build-only
`devDependencies` are not included in this table.

| Package | Locked version | License | Upstream |
| --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.29.0 | MIT | [source](https://github.com/modelcontextprotocol/typescript-sdk) · [package](https://www.npmjs.com/package/@modelcontextprotocol/sdk/v/1.29.0) |
| `ink` | 7.1.0 | MIT | [source](https://github.com/vadimdemedes/ink) · [package](https://www.npmjs.com/package/ink/v/7.1.0) |
| `ink-text-input` | 6.0.0 | MIT | [source](https://github.com/vadimdemedes/ink-text-input) · [package](https://www.npmjs.com/package/ink-text-input/v/6.0.0) |
| `openai` | 6.45.0 | Apache-2.0 | [source](https://github.com/openai/openai-node) · [package](https://www.npmjs.com/package/openai/v/6.45.0) |
| `react` | 19.2.7 | MIT | [source](https://github.com/facebook/react) · [package](https://www.npmjs.com/package/react/v/19.2.7) |
| `zod` | 4.4.3 | MIT | [source](https://github.com/colinhacks/zod) · [package](https://www.npmjs.com/package/zod/v/4.4.3) |

Transitive npm packages are pinned in `bun.lock`; their upstream license files
remain authoritative.

## Direct Rust dependencies

These crates are direct dependencies of the native runner. Versions are locked
in `native/windows-sandbox-runner/Cargo.lock`.

| Crate | Locked version | License | Upstream |
| --- | --- | --- | --- |
| `anyhow` | 1.0.103 | MIT OR Apache-2.0 | [source](https://github.com/dtolnay/anyhow) · [crate](https://crates.io/crates/anyhow/1.0.103) |
| `serde` | 1.0.228 | MIT OR Apache-2.0 | [source](https://github.com/serde-rs/serde) · [crate](https://crates.io/crates/serde/1.0.228) |
| `serde_json` | 1.0.150 | MIT OR Apache-2.0 | [source](https://github.com/serde-rs/json) · [crate](https://crates.io/crates/serde_json/1.0.150) |
| `sha2` | 0.10.9 | MIT OR Apache-2.0 | [source](https://github.com/RustCrypto/hashes) · [crate](https://crates.io/crates/sha2/0.10.9) |
| `windows-sys` | 0.52.0 | MIT OR Apache-2.0 | [source](https://github.com/microsoft/windows-rs) · [crate](https://crates.io/crates/windows-sys/0.52.0) |

Transitive Rust crates are pinned in
`native/windows-sandbox-runner/Cargo.lock`; their upstream license files remain
authoritative.
