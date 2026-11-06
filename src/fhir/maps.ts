import { readdir } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { parseFmlModel, resolveFmlStructureType, type FmlSource } from "@fhirpath-lab/validator";

const DEFAULT_MAP_DIRECTORIES = ["R4_R6", "R6_R4"].map((direction) =>
  resolve(import.meta.dir, "..", "..", "fml-maps", direction, "maps", "StructureMaps"));

export function configuredMapDirectories(value = process.env.FML_MAP_DIRS): string[] {
  if (value === undefined) return DEFAULT_MAP_DIRECTORIES;
  const directories = value.split(delimiter).map((directory) => directory.trim());
  if (directories.some((directory) => !directory)) throw new Error("FML_MAP_DIRS must contain non-empty directory paths");
  return directories.map((directory) => resolve(directory));
}

export interface ResourceMap {
  source: FmlSource;
  entryGroup: string;
}

export interface MapCatalog {
  sources: readonly FmlSource[];
  resourceMaps: ReadonlyMap<string, ResourceMap>;
  /** Maps that don't convert one resource to the same type, such as a group of rows. */
  byCanonical: ReadonlyMap<string, FmlSource>;
}

export async function loadMapCatalog(directories: readonly string[]): Promise<MapCatalog> {
  if (!directories.length) throw new Error("At least one FML map directory is required");
  const files = new Set<string>();
  const scan = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".fml")) files.add(path);
    }
  };
  for (const directory of new Set(directories.map((directory) => resolve(directory)))) await scan(directory);
  if (!files.size) throw new Error(`No FML maps found in ${directories.join(delimiter)}`);

  const sources: FmlSource[] = [];
  const resourceMaps = new Map<string, ResourceMap>();
  const canonicals = new Map<string, string>();
  const byCanonical = new Map<string, FmlSource>();
  for (const path of files) {
    const source: FmlSource = {
      sourceName: path,
      sourceText: (await Bun.file(path).text()).replace(/^\uFEFF/, ""),
      defaultFhirVersion: "R4",
    };
    const model = parseFmlModel(source.sourceText);
    if (!model) throw new Error(`Unable to parse FML map ${path}`);
    const canonical = model.mapDeclaration?.url ?? model.metadata.find((metadata) => metadata.path === "url")?.value;
    const version = model.metadata.find((metadata) => metadata.path === "version")?.value;
    if (typeof canonical !== "string" || !canonical) throw new Error(`FML map ${path} has no canonical URL`);
    const identity = `${canonical}|${version ?? ""}`;
    const previous = canonicals.get(identity);
    if (previous) throw new Error(`Ambiguous FML canonical ${identity}: ${previous} and ${path}`);
    canonicals.set(identity, path);
    sources.push(source);
    byCanonical.set(canonical, source);

    if (model.sourceModelVersion !== "R4" || model.targetModelVersion !== "R6") continue;
    for (const group of model.groups) {
      if (group.typeMode === "types") continue;
      const inputs = group.parameters.filter((parameter) => parameter.mode === "source");
      const outputs = group.parameters.filter((parameter) => parameter.mode === "target");
      if (inputs.length !== 1 || outputs.length !== 1) continue;
      const input = model.structures.find((structure) => structure.mode === "source" && structure.alias === inputs[0]!.type);
      const output = model.structures.find((structure) => structure.mode === "target" && structure.alias === outputs[0]!.type);
      if (!input || !output) continue;
      const type = resolveFmlStructureType(input.url);
      if (!type || type !== resolveFmlStructureType(output.url)) continue;
      const previousMap = resourceMaps.get(type);
      if (previousMap) {
        throw new Error(`Ambiguous R4 -> R6 map for ${type}: ${previousMap.source.sourceName} and ${path}`);
      }
      resourceMaps.set(type, { source, entryGroup: group.name });
    }
  }
  return { sources, resourceMaps, byCanonical };
}
