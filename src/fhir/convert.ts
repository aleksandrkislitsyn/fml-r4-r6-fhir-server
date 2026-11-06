import type { StoredResource } from "../db/repository.ts";
import type { FhirVersion } from "./validator.ts";
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
