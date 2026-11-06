import type { StoredResource } from "../db/repository.ts";

/**
 * Rules for keeping one R6 BodyStructure and its R4 rows consistent. The R6 resource
 * `<id>` is stored as rows `<id>`, `<id>--2`, `<id>--3`; the suffix gives the order of
 * `includedStructure`.
 */
const SEPARATOR = "--";

export const MORPHOLOGY_URL =
  "http://hl7.org/fhir/6.0/StructureDefinition/extension-BodyStructure.includedStructure.morphology";
export const LATERALITY_URL =
  "http://hl7.org/fhir/6.0/StructureDefinition/extension-BodyStructure.includedStructure.laterality";

const SHARED_FIELDS = ["language", "text", "identifier", "active", "description", "image", "patient"];

const R6_ROOT = new Set(["resourceType", "id", "meta", ...SHARED_FIELDS, "includedStructure"]);
const R6_INCLUDED = new Set(["structure", "laterality", "qualifier", "morphology"]);
const R4_ROOT = new Set(["resourceType", "id", "meta", ...SHARED_FIELDS, "morphology", "location", "locationQualifier", "extension"]);

export const baseId = (id: string) => id.split(SEPARATOR)[0]!;
export const isSecondaryId = (id: string) => id.includes(SEPARATOR);
export const rowId = (base: string, index: number) => (index === 0 ? base : `${base}${SEPARATOR}${index + 1}`);
/** Longest client id that still leaves room for a row suffix within FHIR's 64 characters. */
export const MAX_BASE_ID_LENGTH = 58;

/** R6 content with no place in R4 yet. It is rejected rather than silently dropped. */
export function unsupportedR6(resource: any): string[] {
  const found = Object.keys(resource).filter((k) => !R6_ROOT.has(k)).map((k) => `BodyStructure.${k}`);
  for (const inc of resource.includedStructure ?? []) {
    for (const k of Object.keys(inc)) {
      if (!R6_INCLUDED.has(k)) found.push(`BodyStructure.includedStructure.${k}`);
    }
    for (const k of Object.keys(inc.laterality ?? {})) {
      if (k !== "coding" && k !== "text") found.push(`BodyStructure.includedStructure.laterality.${k}`);
    }
  }
  return [...new Set(found)];
}

/** R4 content the R6 side couldn't return, which a later R6 update would then lose. */
export function unsupportedR4(resource: any): string[] {
  const found = Object.keys(resource).filter((k) => !R4_ROOT.has(k)).map((k) => `BodyStructure.${k}`);
  for (const ext of resource.extension ?? []) {
    if (ext.url !== MORPHOLOGY_URL) found.push(`BodyStructure.extension(${ext.url})`);
  }
  return [...new Set(found)];
}

const sameConcept = (a: any, b: any) =>
  JSON.stringify(a.coding ?? null) === JSON.stringify(b.coding ?? null) && (a.text ?? null) === (b.text ?? null);

/**
 * R4 clients often drop extensions they don't understand, so when an update leaves ours
 * out, they come back from the stored row. A laterality marker only returns if its code
 * is still in `locationQualifier`; removing the code means the client removed laterality.
 */
export function carryForwardExtensions(stored: any, incoming: any): any {
  const next = structuredClone(incoming);

  const storedMorphology = (stored.extension ?? []).filter((e: any) => e.url === MORPHOLOGY_URL);
  if (storedMorphology.length > 0 && !(next.extension ?? []).some((e: any) => e.url === MORPHOLOGY_URL)) {
    next.extension = [...(next.extension ?? []), ...storedMorphology];
  }

  const isMarked = (q: any) => (q.extension ?? []).some((e: any) => e.url === LATERALITY_URL);
  const marked = (stored.locationQualifier ?? []).find(isMarked);
  const qualifiers: any[] = next.locationQualifier ?? [];
  if (marked && !qualifiers.some(isMarked)) {
    const match = qualifiers.find((q) => sameConcept(q, marked));
    if (match) match.extension = [...(match.extension ?? []), { url: LATERALITY_URL, valueBoolean: true }];
  }
  return next;
}

/** Applies the addressed row's shared fields to another row in the group. */
export function withSharedFieldsFrom(source: any, row: StoredResource): StoredResource {
  const next: any = { ...row };
  for (const field of SHARED_FIELDS) {
    if (source[field] === undefined) delete next[field];
    else next[field] = source[field];
  }
  return next;
}
