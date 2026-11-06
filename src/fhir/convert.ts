import { resolve } from "node:path";
import type { StoredResource } from "../db/repository.ts";
import { rowId } from "./bodystructure.ts";
import { loadMap, runMap } from "./fml.ts";
import type { Validator } from "./validator.ts";

const MAPS = resolve(import.meta.dir, "../../fml-maps");

export interface Converter {
  /** One R6 resource to its R4 rows. Rows get ids `<id>`, `<id>--2`, ... */
  toStorage(resource: StoredResource, id: string): StoredResource[];
  /** A group's R4 rows, primary first, to one R6 resource. */
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
    toStorage(resource, id) {
      const bundle = runMap(toR4, resource, "Bundle", validators.R4);
      const labels = keepLabels(resource.meta);
      return (bundle.entry ?? []).map((entry: any, index: number) => ({
        ...entry.resource,
        id: rowId(id, index),
        ...(labels ? { meta: labels } : {}),
      }));
    },
    fromStorage(rows) {
      const bundle = { resourceType: "Bundle", type: "collection", entry: rows.map((resource) => ({ resource })) };
      const primary = rows[0]!;
      return { ...runMap(toR6, bundle, "BodyStructure", validators.R6), id: primary.id, meta: primary.meta };
    },
  };
}

/** Version and timestamps are per row and profiles are version-specific, so only labels carry over. */
function keepLabels(meta: any): Record<string, unknown> | undefined {
  if (!meta?.tag && !meta?.security) return undefined;
  return { ...(meta.tag ? { tag: meta.tag } : {}), ...(meta.security ? { security: meta.security } : {}) };
}
