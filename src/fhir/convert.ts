import type { StoredResource } from "../db/repository.ts";
import type { FhirVersion } from "./validator.ts";

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

export function fromStorage(version: FhirVersion, resource: StoredResource): StoredResource {
  if (version === "R4") return resource;
  throw new Error("R4 -> R6 conversion is not implemented yet"); // TODO: FML 4to6
}
