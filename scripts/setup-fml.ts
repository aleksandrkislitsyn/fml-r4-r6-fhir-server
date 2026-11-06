import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

// The executor is internal and is not published to npm. Build a pinned upstream
// revision locally; do not copy an unversioned binary or depend on a sibling checkout.
const revision = "f10b0bf341cdd656ee89a23b8122e14d6a211948";
const root = resolve(import.meta.dir, "..");
const cache = resolve(root, ".fml-engine");
const stamp = Bun.file(`${cache}/revision`);
if (await stamp.exists() && (await stamp.text()).trim() === revision && await Bun.file(`${cache}/engine.mjs`).exists()) {
  process.exit(0);
}
await mkdir(cache, { recursive: true });
console.log("Preparing Brian's FML executor...");
const response = await fetch(`https://codeload.github.com/brianpos/fhirpath-lab/tar.gz/${revision}`);
if (!response.ok) throw new Error(`FML source download failed: ${response.status}`);
await Bun.write(`${cache}/source.tar.gz`, response);
const source = `${cache}/source`;
await rm(source, { recursive: true, force: true });
await mkdir(source, { recursive: true });
async function run(cmd: string[], cwd: string) {
  const child = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit", env: {
    ...process.env, BUN_INSTALL_CACHE_DIR: `${cache}/install-cache`,
  } });
  if (await child.exited !== 0) throw new Error(`FML setup failed: ${cmd.join(" ")}`);
}
await run(["tar", "-xzf", `${cache}/source.tar.gz`, "-C", source, "--strip-components=1"], root);
// Install only the engine's runtime dependencies, not the Lab's full web app.
await Bun.write(`${source}/package.json`, JSON.stringify({ private: true, dependencies: {
  antlr4: "4.13.2", entities: "6.0.1", fhirpath: "5.0.0", "lossless-json": "4.3.0", luxon: "3.7.2",
} }));
await rm(`${source}/package-lock.json`, { force: true });
await rm(`${source}/bun.lock`, { force: true });
await run([process.execPath, "install", "--ignore-scripts"], source);
const built = await Bun.build({
  entrypoints: [`${source}/fml-vscode-extension/fml-executor/src/index.ts`],
  outdir: cache, naming: "engine.mjs", target: "bun",
  plugins: [{ name: "validator-source", setup(build) {
    build.onResolve({ filter: /^@fhirpath-lab\/validator$/ }, () => ({
      path: `${source}/fml-vscode-extension/fml-validator/src/index.ts`,
    }));
  } }],
});
if (!built.success) throw new AggregateError(built.logs, "FML executor build failed");
await Bun.write(stamp, revision);
console.log("FML executor ready.");
