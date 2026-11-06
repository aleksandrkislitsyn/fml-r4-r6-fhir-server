import type { StoredResource } from "../db/repository.ts";

/**
 * Rules for keeping one R6 BodyStructure and its R4 rows consistent. The R6 resource
 * `<id>` is stored as rows `<id>`, `<id>--2`, `<id>--3`. A row keeps its id for as long as
 * its structure exists, numbers are never reused, and the row-group extension holds the
 * order of `includedStructure`.
 */
const SEPARATOR = "--";

const XVER = "http://hl7.org/fhir/6.0/StructureDefinition/extension-";
const included = (element: string) => `${XVER}BodyStructure.includedStructure.${element}`;

export const MORPHOLOGY_URL = included("morphology");
export const LATERALITY_URL = included("laterality");
export const EXCLUDED_URL = `${XVER}BodyStructure.excludedStructure`;
/** Server-managed link between rows. Clients can't set it. */
export const ROW_GROUP_URL = "http://example.org/fhir/StructureDefinition/bodystructure-row-group";

const ROW_EXTENSIONS = new Set([
  MORPHOLOGY_URL,
  included("bodyLandmarkOrientation"),
  included("spatialReference"),
  included("image"),
  included("origin"),
]);
const STORABLE_EXTENSIONS = new Set([...ROW_EXTENSIONS, EXCLUDED_URL, ROW_GROUP_URL]);

const ATTACHMENT_EXTENSIONS = new Set(
  ["height", "width", "frames", "duration", "pages"].map((f) => `${XVER}Attachment.${f}`),
);

const SHARED_FIELDS = ["language", "text", "identifier", "active", "description", "image", "patient"];

const STRUCTURE_FIELDS = ["structure", "laterality", "qualifier", "morphology", "bodyLandmarkOrientation", "spatialReference", "image", "origin"];
const R6_ROOT = new Set(["resourceType", "id", "meta", ...SHARED_FIELDS, "includedStructure", "excludedStructure"]);
const R6_INCLUDED = new Set(["id", ...STRUCTURE_FIELDS]);
const R6_EXCLUDED = new Set(STRUCTURE_FIELDS);
const R6_LANDMARK = new Set(["landmarkDescription", "clockFacePosition", "distanceFromLandmark", "surfaceOrientation"]);
const R6_DISTANCE = new Set(["device", "value"]);
const R6_ATTACHMENT = new Set(["contentType", "data", "url", "size", "hash", "title", "creation", "height", "width", "frames", "duration", "pages"]);
const R4_ROOT = new Set(["resourceType", "id", "meta", ...SHARED_FIELDS, "morphology", "location", "locationQualifier", "extension"]);
const R4_ATTACHMENT = new Set(["contentType", "data", "url", "size", "hash", "title", "creation", "extension"]);

export const baseId = (id: string) => id.split(SEPARATOR)[0]!;
export const isSecondaryId = (id: string) => id.includes(SEPARATOR);
/** Longest client id that still leaves room for a row suffix within FHIR's 64 characters. */
export const MAX_BASE_ID_LENGTH = 54;

const suffixOf = (id: string) => Number(id.split(SEPARATOR)[1] ?? 1);
const idForSuffix = (base: string, suffix: number) => (suffix === 1 ? base : `${base}${SEPARATOR}${suffix}`);
/** The value of `includedStructure.id` for a row. */
export const elementId = (rowId: string) => String(suffixOf(rowId));

/** Reports keys outside `allowed` as `<path>.<key>`. */
function outside(node: any, allowed: Set<string>, path: string): string[] {
  return Object.keys(node ?? {}).filter((k) => !allowed.has(k)).map((k) => `${path}.${k}`);
}

/** R4 Attachment.size is an unsignedInt, and the validator doesn't enforce its maximum. */
const R4_MAX_UNSIGNED_INT = 2_147_483_647;

function unsupportedAttachment(image: any, path: string): string[] {
  const found = outside(image, R6_ATTACHMENT, path);
  if (image.size !== undefined && Number(image.size) > R4_MAX_UNSIGNED_INT) {
    found.push(`${path}.size (larger than R4 can hold)`);
  }
  return found;
}

function unsupportedStructure(structure: any, allowed: Set<string>, path: string): string[] {
  const found = outside(structure, allowed, path);
  found.push(...outside(structure.laterality, new Set(["coding", "text"]), `${path}.laterality`));
  for (const landmark of structure.bodyLandmarkOrientation ?? []) {
    const lm = `${path}.bodyLandmarkOrientation`;
    found.push(...outside(landmark, R6_LANDMARK, lm));
    for (const distance of landmark.distanceFromLandmark ?? []) {
      found.push(...outside(distance, R6_DISTANCE, `${lm}.distanceFromLandmark`));
    }
  }
  for (const image of structure.image ?? []) found.push(...unsupportedAttachment(image, `${path}.image`));
  return found;
}

/** R6 content with no place in R4. It is rejected rather than silently dropped. */
export function unsupportedR6(resource: any): string[] {
  const found = outside(resource, R6_ROOT, "BodyStructure");
  for (const image of resource.image ?? []) found.push(...unsupportedAttachment(image, "BodyStructure.image"));
  for (const s of resource.includedStructure ?? []) {
    found.push(...unsupportedStructure(s, R6_INCLUDED, "BodyStructure.includedStructure"));
  }
  for (const s of resource.excludedStructure ?? []) {
    found.push(...unsupportedStructure(s, R6_EXCLUDED, "BodyStructure.excludedStructure"));
  }
  return [...new Set(found)];
}

/** R4 content the R6 side couldn't return, which a later R6 update would then lose. */
export function unsupportedR4(resource: any): string[] {
  const found = outside(resource, R4_ROOT, "BodyStructure");
  for (const ext of resource.extension ?? []) {
    if (!STORABLE_EXTENSIONS.has(ext.url)) found.push(`BodyStructure.extension(${ext.url})`);
  }
  for (const image of resource.image ?? []) {
    found.push(...outside(image, R4_ATTACHMENT, "BodyStructure.image"));
    for (const ext of image.extension ?? []) {
      if (!ATTACHMENT_EXTENSIONS.has(ext.url)) found.push(`BodyStructure.image.extension(${ext.url})`);
    }
  }
  return [...new Set(found)];
}

const sameConcept = (a: any, b: any) =>
  JSON.stringify(a.coding ?? null) === JSON.stringify(b.coding ?? null) && (a.text ?? null) === (b.text ?? null);

/** The same attachment in two versions of a row, ignoring its extensions. */
function sameAttachment(a: any, b: any): boolean {
  const { extension: _a, ...left } = a;
  const { extension: _b, ...right } = b;
  return JSON.stringify(sort(left)) === JSON.stringify(sort(right));
}

/**
 * Decides which extensions an R4 update keeps:
 * - `replaceExtensions` (the X-Replace-Extensions header): the body is everything, nothing returns.
 * - An `extension` array: it is the client's intent, so anything left out of it is removed.
 * - No array: the client dropped what it doesn't understand, so ours come back.
 * Markers on elements come back unless the header is set, and a laterality marker
 * only if its code is still in `locationQualifier`.
 */
export function carryForwardExtensions(stored: any, incoming: any, replaceExtensions = false): any {
  const next = structuredClone(incoming);
  if (replaceExtensions) return next;

  if (!next.extension) {
    const kept = (stored.extension ?? []).filter((e: any) => e.url !== ROW_GROUP_URL);
    if (kept.length > 0) next.extension = kept;
  }

  const isMarked = (q: any) => (q.extension ?? []).some((e: any) => e.url === LATERALITY_URL);
  const marked = (stored.locationQualifier ?? []).find(isMarked);
  const qualifiers: any[] = next.locationQualifier ?? [];
  if (marked && !qualifiers.some(isMarked)) {
    const match = qualifiers.find((q) => sameConcept(q, marked));
    if (match) match.extension = [...(match.extension ?? []), { url: LATERALITY_URL, valueBoolean: true }];
  }

  for (const image of next.image ?? []) {
    if (image.extension) continue;
    const before = (stored.image ?? []).find((s: any) => sameAttachment(s, image));
    if (before?.extension) image.extension = before.extension;
  }
  return next;
}

/** Applies the addressed row's shared fields and extensions to another row in the group. */
export function withSharedFieldsFrom(source: any, row: StoredResource): StoredResource {
  const next: any = { ...row };
  for (const field of SHARED_FIELDS) {
    if (source[field] === undefined) delete next[field];
    else next[field] = source[field];
  }
  const own = (next.extension ?? []).filter((e: any) => e.url !== EXCLUDED_URL);
  const shared = (source.extension ?? []).filter((e: any) => e.url === EXCLUDED_URL);
  if (own.length + shared.length > 0) next.extension = [...own, ...shared];
  else delete next.extension;
  return next;
}

const rowGroupPosition = (row: any): number | undefined =>
  row.extension
    ?.find((e: any) => e.url === ROW_GROUP_URL)
    ?.extension?.find((e: any) => e.url === "position")?.valuePositiveInt;

/** Rows in `includedStructure` order. */
export function orderRows<T extends StoredResource>(rows: T[]): T[] {
  const rank = (row: T) => rowGroupPosition(row) ?? suffixOf(row.id!);
  return [...rows].sort((a, b) => rank(a) - rank(b) || suffixOf(a.id!) - suffixOf(b.id!));
}

/**
 * Writes the row-group extension on rows given in order, replacing anything a client sent.
 * Secondary rows point to the primary, and the primary lists the others in order, so an R4
 * client can find the whole group from any row. A group of one has none, so a plain R4
 * resource stays plain.
 */
export function withRowLinks(rows: StoredResource[], base: string): StoredResource[] {
  const members = rows
    .filter((row) => row.id !== base)
    .map((row) => ({ url: "member", valueReference: { reference: `BodyStructure/${row.id}` } }));
  return rows.map((row, index) => {
    const { extension, ...rest } = row as any;
    const own = (extension ?? []).filter((e: any) => e.url !== ROW_GROUP_URL);
    if (rows.length > 1) {
      const position = { url: "position", valuePositiveInt: index + 1 };
      own.push({
        url: ROW_GROUP_URL,
        extension:
          row.id === base
            ? [position, ...members]
            : [{ url: "primary", valueReference: { reference: `BodyStructure/${base}` } }, position],
      });
    }
    return own.length > 0 ? { ...rest, extension: own } : rest;
  });
}

/** Key order doesn't matter for "same content". */
function sort(value: any): any {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sort(value[k])]));
  }
  return value;
}
const content = (structure: any) => {
  const { id: _id, ...rest } = structure;
  return JSON.stringify(sort(rest));
};

/**
 * Picks the row id for each incoming `includedStructure`: first by its element id, then by
 * identical content for clients that don't send ids, otherwise a new row. `lastSuffix` is
 * the highest number the group has ever used, so numbers are never reused.
 *
 * The R6 resource needs a row with its own id. If nothing claims the primary row, the first
 * structure moves into it. That is the one case where a structure changes row.
 */
export function assignRowIds(base: string, existing: any[], incoming: any[], lastSuffix: number): string[] {
  const free = new Map<string, any>(existing.map((s) => [String(s.id), s]));
  const assigned: (string | undefined)[] = incoming.map(() => undefined);

  incoming.forEach((s, i) => {
    if (s.id !== undefined && free.has(String(s.id))) {
      assigned[i] = String(s.id);
      free.delete(String(s.id));
    }
  });
  incoming.forEach((s, i) => {
    if (assigned[i] !== undefined || s.id !== undefined) return;
    const match = [...free.entries()].find(([, existingStructure]) => content(existingStructure) === content(s));
    if (match) {
      assigned[i] = match[0];
      free.delete(match[0]);
    }
  });

  if (!assigned.includes("1") && incoming.length > 0) assigned[0] = "1";

  let next = Math.max(lastSuffix, 1);
  return assigned.map((key) => idForSuffix(base, key === undefined ? ++next : Number(key)));
}
