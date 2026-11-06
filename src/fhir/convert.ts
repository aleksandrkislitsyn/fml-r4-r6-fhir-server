import { resolve } from "node:path";
import type { StoredResource } from "../db/repository.ts";
import { baseId, elementId, isSecondaryId, withRowLinks } from "./bodystructure.ts";
import { loadMap, runMap } from "./fml.ts";
import type { FhirVersion, Validator } from "./validator.ts";
import {
  createSingleInputRequest, FmlExecutor,
  type FmlDiagnostic, type PreparedFmlProgram,
} from "@fhirpath-lab/fml-executor";
import { configuredMapDirectories, loadMapCatalog } from "./maps.ts";

export interface ResourceConverter {
  toR6(resource: StoredResource, signal?: AbortSignal): Promise<StoredResource>;
}

export class ConversionError extends Error {
  constructor(
    message: string,
    readonly diagnostics: readonly FmlDiagnostic[] = [],
    readonly status = 500,
    readonly code = "exception",
  ) {
    super(message);
  }
}

function isResource(value: unknown): value is StoredResource {
  return typeof value === "object" && value !== null && "resourceType" in value && typeof value.resourceType === "string";
}

export function createFmlConverter(directories = configuredMapDirectories()): ResourceConverter {
  let runtime: Promise<{ catalog: Awaited<ReturnType<typeof loadMapCatalog>>; executor: FmlExecutor }> | undefined;
  const programs = new Map<string, Promise<{ program: PreparedFmlProgram; entryGroup: string; executor: FmlExecutor }>>();

  const prepare = async (type: string) => {
    runtime ??= loadMapCatalog(directories).then((catalog) => ({
      catalog, executor: new FmlExecutor({ maps: catalog.sources }),
    }));
    const { catalog, executor } = await runtime;
    const map = catalog.resourceMaps.get(type);
    if (!map) throw new ConversionError(`No R4 -> R6 map is configured for ${type}`, [], 501, "not-supported");
    const result = await executor.prepare(map.source);
    if (result.status !== "success") throw new ConversionError(`Unable to prepare R4 -> R6 map for ${type}`, result.diagnostics);
    if (result.diagnostics.length) {
      console.warn(`FML ${map.source.sourceName}: prepared with ${result.diagnostics.length} diagnostics`);
    }
    return { program: result.value, entryGroup: map.entryGroup, executor };
  };

  return {
    async toR6(resource, signal) {
      signal?.throwIfAborted();
      let prepared = programs.get(resource.resourceType);
      if (!prepared) {
        prepared = prepare(resource.resourceType);
        programs.set(resource.resourceType, prepared);
      }
      let executable: Awaited<typeof prepared>;
      try {
        executable = await prepared;
      } catch (error) {
        programs.delete(resource.resourceType);
        throw error;
      }
      signal?.throwIfAborted();
      const { program, entryGroup, executor } = executable;
      const request = createSingleInputRequest(program, resource, entryGroup);
      const result = await executor.execute(request, { signal });
      if (result.status !== "success") {
        throw new ConversionError(`R4 -> R6 execution failed for ${resource.resourceType}`, result.diagnostics);
      }
      const target = result.value.targets[0]?.value;
      if (!isResource(target) || target.resourceType !== resource.resourceType
        || target.id !== resource.id || target.meta?.versionId !== resource.meta?.versionId
        || target.meta?.lastUpdated !== resource.meta?.lastUpdated) {
        throw new ConversionError(`R4 -> R6 map for ${resource.resourceType} did not preserve resource identity and version metadata`);
      }
      return target;
    },
  };
}

/** Storage remains R4; R6 writes require reverse maps and are not supported. */
export function toStorage(version: FhirVersion, resource: StoredResource): StoredResource {
  if (version === "R4") return resource;
  throw new ConversionError("R6 writes are not supported", [], 405, "not-supported");
}

export async function fromStorage(
  version: FhirVersion,
  resource: StoredResource,
  converter?: ResourceConverter,
  signal?: AbortSignal,
): Promise<StoredResource> {
  if (version === "R4") return resource;
  if (!converter) throw new ConversionError("R6 conversion is not configured", [], 501, "not-supported");
  return converter.toR6(resource, signal);
}

const MAPS = resolve(import.meta.dir, "../../fml-maps");

export interface Converter {
  /** One R6 resource to its R4 rows, in `includedStructure` order, with the given row ids. */
  toStorage(resource: StoredResource, rowIds: string[]): StoredResource[];
  /** A group's R4 rows, in `includedStructure` order, to one R6 resource. */
  fromStorage(rows: StoredResource[]): StoredResource;
}

/**
 * Conversion between `/R6` requests and the stored R4, using FML. The database holds R4
 * only, so `/R4` content doesn't need converting to be stored. One R6 resource can become
 * several R4 rows, so these work on arrays.
 */
export async function loadConverter(validators: { R4: Validator; R6: Validator }): Promise<Converter> {
  const toR4 = await loadMap(`${MAPS}/R6_R4/maps/StructureMaps/BodyStructure_6to4.fml`);
  const toR6 = await loadMap(`${MAPS}/R4_R6/maps/StructureMaps/BodyStructure_4to6.fml`);

  return {
    toStorage(resource, rowIds) {
      const bundle = runMap(toR4, resource, "Bundle", validators.R4);
      const labels = keepLabels(resource.meta);
      const rows: StoredResource[] = (bundle.entry ?? []).map((entry: any, index: number) => ({
        ...entry.resource,
        id: rowIds[index],
        ...(labels ? { meta: labels } : {}),
      }));
      return withRowLinks(rows, baseId(rowIds[0]!));
    },
    fromStorage(rows) {
      const bundle = { resourceType: "Bundle", type: "collection", entry: rows.map((resource) => ({ resource })) };
      const primary = rows.find((r) => !isSecondaryId(r.id!)) ?? rows[0]!;
      const merged = runMap(toR6, bundle, "BodyStructure", validators.R6);
      merged.includedStructure.forEach((structure: any, index: number) => {
        structure.id = elementId(rows[index]!.id!);
      });
      return { ...merged, id: primary.id, meta: primary.meta };
    },
  };
}

/** Version and timestamps are per row and profiles are version-specific, so only labels carry over. */
function keepLabels(meta: any): Record<string, unknown> | undefined {
  if (!meta?.tag && !meta?.security) return undefined;
  return { ...(meta.tag ? { tag: meta.tag } : {}), ...(meta.security ? { security: meta.security } : {}) };
}
