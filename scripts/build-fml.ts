import { build } from "esbuild";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "..");
const packages = resolve(root, "vendor", "fhirpath-lab", "fml-vscode-extension");
const validator = resolve(packages, "fml-validator", "dist", "index.js");
const validatorTypes = resolve(packages, "fml-validator", "dist", "fml-vscode-extension", "fml-validator", "src", "index.d.ts");
const diagnosticsHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (file) => file,
  getCurrentDirectory: () => root,
  getNewLine: () => "\n",
};

for (const name of ["fml-validator", "fml-executor"]) {
  const cwd = resolve(packages, name);
  if (!(await Bun.file(resolve(cwd, "package.json")).exists())) {
    throw new Error("FML submodule is missing. Run git submodule update --init --recursive first.");
  }
  const configPath = resolve(cwd, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.formatDiagnostics([config.error], diagnosticsHost));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, cwd, {
    paths: { "@fhirpath-lab/validator": [validatorTypes] },
  });
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) throw new Error(ts.formatDiagnostics(diagnostics, diagnosticsHost));
  const emitted = program.emit();
  if (emitted.emitSkipped || emitted.diagnostics.length) {
    throw new Error(`Type declaration build failed for ${name}: ${ts.formatDiagnostics(emitted.diagnostics, diagnosticsHost)}`);
  }

  await build({
    absWorkingDir: cwd,
    entryPoints: ["src/index.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["antlr4"],
    alias: name === "fml-executor" ? { "@fhirpath-lab/validator": validator } : undefined,
    outfile: "dist/index.js",
  });
  if (name === "fml-executor") {
    await build({
      absWorkingDir: cwd,
      entryPoints: ["src/index.ts"],
      bundle: true,
      platform: "browser",
      format: "esm",
      external: ["antlr4"],
      alias: { "@fhirpath-lab/validator": validator },
      outfile: "dist/index.mjs",
    });
  }
  if (name === "fml-validator") {
    await Bun.write(resolve(cwd, "dist", "index.d.ts"),
      'export * from "./fml-vscode-extension/fml-validator/src/index";\n');
  }
}
