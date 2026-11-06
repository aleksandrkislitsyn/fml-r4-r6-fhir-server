import type { StoredResource } from "../db/repository.ts";
import type { FhirVersion } from "./validator.ts";

/**
 * Conversion between a wire FHIR version and the storage version (R6).
 *
 * This is the seam for the FML layer. For now it is the identity: R4 Patient
 * JSON is stored as-is. When the StructureMaps are in place, `toStorage("R4", …)`
 * runs the R4→R6 map and `fromStorage("R4", …)` runs R6→R4.
 */
export function toStorage(version: FhirVersion, resource: StoredResource): StoredResource {
  if (version === "R6") return resource;
  return resource; // TODO: FML R4 -> R6
}

export function fromStorage(version: FhirVersion, resource: StoredResource): StoredResource {
  if (version === "R6") return resource;
  return resource; // TODO: FML R6 -> R4
}
