import type { StoredResource } from "../db/repository.ts";
import { baseId, elementId, isSecondaryId, withRowLinks, withUniqueBodyStructures } from "./bodystructure.ts";
import type { FhirVersion } from "./validator.ts";
import {
  createSingleInputRequest, FmlExecutor, stringifyFmlJson,
  type FmlDiagnostic, type PreparedFmlProgram,
} from "@fhirpath-lab/fml-executor";
import { configuredMapDirectories, loadMapCatalog } from "./maps.ts";

export interface ResourceConverter {
  toR6(resource: StoredResource, signal?: AbortSignal): Promise<StoredResource>;
}

/** Conversion for types stored as one R4 resource and writable through R6. */
export interface WriteConverter extends ResourceConverter {
  /** The R4 form of an R6 resource. Keeps its id, and of `meta` only the labels. */
  toR4(resource: StoredResource, signal?: AbortSignal): Promise<StoredResource>;
}

/** Conversion for types where one R6 resource is stored as several linked R4 rows. */
export interface GroupConverter {
  /** One R6 resource to its R4 rows, in `includedStructure` order, with the given row ids. */
  toStorage(resource: StoredResource, rowIds: string[], signal?: AbortSignal): Promise<StoredResource[]>;
  /** A group's R4 rows, in `includedStructure` order, to one R6 resource. */
  fromStorage(rows: StoredResource[], signal?: AbortSignal): Promise<StoredResource>;
}

const XVER = "http://hl7.org/fhir/uv/xver/StructureMap";
const BODY_STRUCTURE_TO_R4 = `${XVER}/BodyStructure6to4`;
const BODY_STRUCTURE_TO_R6 = `${XVER}/BodyStructure4to6`;

/** The engine returns numbers as lossless objects; validators and storage need plain JSON. */
export const plainJson = <T>(value: unknown): T => JSON.parse(stringifyFmlJson(value));

/** Version and timestamps are per row and profiles are version-specific, so only labels carry over. */
function keepLabels(meta: any): Record<string, unknown> | undefined {
  if (!meta?.tag && !meta?.security) return undefined;
  return { ...(meta.tag ? { tag: meta.tag } : {}), ...(meta.security ? { security: meta.security } : {}) };
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

export function createFmlConverter(directories = configuredMapDirectories()): WriteConverter & GroupConverter {
  let runtime: Promise<{ catalog: Awaited<ReturnType<typeof loadMapCatalog>>; executor: FmlExecutor }> | undefined;
  const programs = new Map<string, Promise<{ program: PreparedFmlProgram; entryGroup: string; executor: FmlExecutor }>>();

  const loadRuntime = () => runtime ??= loadMapCatalog(directories).then((catalog) => ({
    catalog, executor: new FmlExecutor({ maps: catalog.sources }),
  }));

  const groupPrograms = new Map<string, Promise<PreparedFmlProgram>>();
  const groupProgram = (canonical: string) => {
    let program = groupPrograms.get(canonical);
    if (!program) {
      program = (async () => {
        const { catalog, executor } = await loadRuntime();
        const source = catalog.byCanonical.get(canonical);
        if (!source) throw new ConversionError(`Map ${canonical} is not configured`, [], 501, "not-supported");
        const result = await executor.prepare(source);
        if (result.status !== "success") throw new ConversionError(`Unable to prepare map ${canonical}`, result.diagnostics);
        return result.value;
      })();
      groupPrograms.set(canonical, program);
      program.catch(() => groupPrograms.delete(canonical));
    }
    return program;
  };

  const runGroupMap = async <T>(canonical: string, input: unknown, signal?: AbortSignal): Promise<T> => {
    const program = await groupProgram(canonical);
    const { executor } = await loadRuntime();
    const result = await executor.execute(createSingleInputRequest(program, input), { signal });
    if (result.status !== "success") throw new ConversionError(`Execution of map ${canonical} failed`, result.diagnostics);
    return plainJson<T>(result.value.targets[0]?.value);
  };

  const prepare = async (type: string) => {
    const { catalog, executor } = await loadRuntime();
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
      return withUniqueBodyStructures(target);
    },

    async toR4(resource, signal) {
      const mapped = await runGroupMap<StoredResource>(`${XVER}/${resource.resourceType}6to4`, resource, signal);
      const labels = keepLabels(resource.meta);
      return {
        ...mapped,
        ...(resource.id === undefined ? {} : { id: resource.id }),
        ...(labels ? { meta: labels } : {}),
      };
    },

    async toStorage(resource, rowIds, signal) {
      const bundle = await runGroupMap<{ entry?: { resource: StoredResource }[] }>(BODY_STRUCTURE_TO_R4, resource, signal);
      const labels = keepLabels(resource.meta);
      const rows = (bundle.entry ?? []).map((entry, index) => ({
        ...entry.resource,
        id: rowIds[index],
        ...(labels ? { meta: labels } : {}),
      }));
      return withRowLinks(rows, baseId(rowIds[0]!));
    },

    async fromStorage(rows, signal) {
      const bundle = { resourceType: "Bundle", type: "collection", entry: rows.map((resource) => ({ resource })) };
      const merged = await runGroupMap<any>(BODY_STRUCTURE_TO_R6, bundle, signal);
      merged.includedStructure.forEach((structure: any, index: number) => {
        structure.id = elementId(rows[index]!.id!);
      });
      const primary = rows.find((row) => !isSecondaryId(row.id!)) ?? rows[0]!;
      return { ...merged, id: primary.id, meta: primary.meta };
    },
  };
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
