import type { StoredResource } from "../db/repository.ts";
import type { FhirVersion } from "./validator.ts";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

async function prepareEncounterMap() {
  const enginePath = resolve(import.meta.dir, "../../.fml-engine/engine.mjs");
  if (!await Bun.file(enginePath).exists()) throw new Error("Run bun run setup:fml before using R6");
  const { FmlExecutor, createSingleInputRequest } = await import(pathToFileURL(enginePath).href);
  const directory = resolve(import.meta.dir, "../../fml-maps/R4_R6/maps/StructureMaps");
  const files = await Array.fromAsync(new Bun.Glob("*.fml").scan({ cwd: directory }));
  const maps = await Promise.all(files.sort().map(async (file) => ({
    sourceText: await Bun.file(`${directory}/${file}`).text(), sourceName: file,
  })));
  const executor = new FmlExecutor({ maps });
  const prepared = await executor.prepare(maps.find((map) => map.sourceName === "Encounter_4to6.fml"));
  if (prepared.status !== "success") throw new Error(`Encounter FML preparation failed: ${JSON.stringify(prepared.diagnostics)}`);
  return { executor, program: prepared.value, createSingleInputRequest };
}

let encounterMap: ReturnType<typeof prepareEncounterMap> | undefined;

/**
 * Conversion between a wire FHIR version and the storage version (R4).
 *
 * The database holds R4 only. `/R4` requests pass straight through.
 * `/R6` requests are converted with FML:
 *   - `toStorage("R6", …)`   runs an R6 → R4 map (6to4; not available yet)
 *   - `fromStorage("R6", …)` runs an R4 → R6 map (fml-maps/R4_R6/…/*_4to6.fml)
 */
export function toStorage(version: FhirVersion, resource: StoredResource): StoredResource {
  if (version === "R4") return resource;
  throw new Error("R6 -> R4 conversion is not implemented yet"); // TODO: FML 6to4
}

export async function fromStorage(version: FhirVersion, resource: StoredResource): Promise<StoredResource> {
  if (version === "R4") return resource;
  if (resource.resourceType !== "Encounter") throw new Error("R6 conversion is only enabled for Encounter");
  const { executor, program, createSingleInputRequest } = await (encounterMap ??= prepareEncounterMap());
  const result = await executor.execute(createSingleInputRequest(program, resource));
  if (result.status !== "success") throw new Error(`Encounter FML execution failed: ${JSON.stringify(result.diagnostics)}`);
  const output = result.value.targets[0]?.value as StoredResource | undefined;
  if (output?.resourceType !== "Encounter") throw new Error("Encounter FML returned no Encounter target");
  return output;
}
