import { BODY_SITE_URL, withBodySiteRepointed } from "../fhir/bodystructure.ts";
import { sql, tableName, type StoredResourceType } from "./index.ts";

/** A resource as stored: always FHIR R4 JSON. */
export type StoredResource = { resourceType: string; id?: string; meta?: any; [k: string]: unknown };

export type ReadResult =
  | { status: "found"; resource: StoredResource }
  | { status: "deleted"; versionId: number }
  | { status: "not-found" };

export class VersionConflict extends Error {}

function withMeta(resource: StoredResource, id: string, versionId: number, lastUpdated: Date): StoredResource {
  return {
    ...resource,
    id,
    meta: { ...resource.meta, versionId: String(versionId), lastUpdated: lastUpdated.toISOString() },
  };
}

export async function create(type: StoredResourceType, resource: StoredResource): Promise<StoredResource> {
  const id = crypto.randomUUID();
  return write(type, id, resource, undefined);
}

export async function read(type: StoredResourceType, id: string): Promise<ReadResult> {
  const t = tableName(type);
  const [row] = await sql.unsafe(`SELECT resource FROM ${t} WHERE id = $1`, [id]);
  if (row) return { status: "found", resource: row.resource };
  const [hist] = await sql.unsafe(
    `SELECT version_id FROM ${t}_history WHERE id = $1 ORDER BY version_id DESC LIMIT 1`,
    [id],
  );
  return hist ? { status: "deleted", versionId: hist.version_id } : { status: "not-found" };
}

export interface ClassToken {
  system?: string;
  code?: string;
}

/** Cross-version extension that carries additional R6 `Encounter.class` values in R4 storage. */
export const ENCOUNTER_CLASS_EXTENSION = "http://hl7.org/fhir/6.0/StructureDefinition/extension-Encounter.class";

/**
 * Without `includeCrossVersion`, only the native R4 Coding is searched (R4 `class`).
 * With it, the codings of the cross-version class extension count too, which is what R6
 * `class` and its R4 backport `class-r6` see. The extension sits on the resource for further
 * classes, and on the R4 `class` element for a first class with more than one coding.
 */
export async function searchEncounterClass(token: ClassToken = {}, includeCrossVersion = false): Promise<StoredResource[]> {
  const rows = await sql.unsafe(
    `SELECT resource FROM encounter
     WHERE (
       ($1::text IS NULL OR COALESCE(resource #>> '{class,system}', '') = $1)
       AND ($2::text IS NULL OR resource #>> '{class,code}' = $2)
     ) OR ($3::boolean AND EXISTS (
       SELECT 1
       FROM jsonb_array_elements(
         COALESCE(resource->'extension', '[]'::jsonb) || COALESCE(resource #> '{class,extension}', '[]'::jsonb)
       ) AS e(value)
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.value #> '{valueCodeableConcept,coding}', '[]'::jsonb)) AS c(value)
       WHERE e.value->>'url' = $4
         AND ($1::text IS NULL OR COALESCE(c.value->>'system', '') = $1)
         AND ($2::text IS NULL OR c.value->>'code' = $2)
     ))
     ORDER BY id`,
    [token.system ?? null, token.code ?? null, includeCrossVersion, ENCOUNTER_CLASS_EXTENSION],
  );
  return rows.map((row: { resource: StoredResource }) => row.resource);
}

/**
 * Create-or-update with a client-chosen id.
 * `ifMatch` is the expected current versionId (from an If-Match header), if any.
 */
export async function update(
  type: StoredResourceType,
  id: string,
  resource: StoredResource,
  ifMatch?: number,
): Promise<{ resource: StoredResource; created: boolean }> {
  const before = await read(type, id);
  const out = await write(type, id, resource, ifMatch);
  return { resource: out, created: before.status !== "found" };
}

async function write(
  type: StoredResourceType,
  id: string,
  resource: StoredResource,
  ifMatch: number | undefined,
): Promise<StoredResource> {
  const t = tableName(type);
  return sql.begin(async (tx) => {
    // Lock the current row so concurrent updates serialize.
    const [current] = await tx.unsafe(`SELECT version_id FROM ${t} WHERE id = $1 FOR UPDATE`, [id]);
    if (ifMatch !== undefined && current?.version_id !== ifMatch) {
      throw new VersionConflict(
        `Version conflict: expected ${ifMatch}, current is ${current?.version_id ?? "none"}`,
      );
    }
    return writeRow(tx, t, id, resource);
  });
}

async function writeRow(tx: any, t: string, id: string, resource: StoredResource): Promise<StoredResource> {
  const [last] = await tx.unsafe(`SELECT max(version_id) AS v FROM ${t}_history WHERE id = $1`, [id]);
  const versionId = (last?.v ?? 0) + 1;
  const now = new Date();
  const stored = withMeta(resource, id, versionId, now);
  await tx.unsafe(
    `INSERT INTO ${t} (id, version_id, last_updated, resource) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (id) DO UPDATE SET version_id = $2, last_updated = $3, resource = $4::jsonb`,
    [id, versionId, now, stored],
  );
  await tx.unsafe(
    `INSERT INTO ${t}_history (id, version_id, last_updated, resource) VALUES ($1, $2, $3, $4::jsonb)`,
    [id, versionId, now, stored],
  );
  return stored;
}

async function deleteRow(tx: any, t: string, id: string, versionId: number): Promise<void> {
  await tx.unsafe(`DELETE FROM ${t} WHERE id = $1`, [id]);
  await tx.unsafe(
    `INSERT INTO ${t}_history (id, version_id, last_updated, resource) VALUES ($1, $2, now(), NULL)`,
    [id, versionId + 1],
  );
}

/*
 * Groups: one R6 resource `<base>` stored as rows `<base>`, `<base>--2`, `<base>--3`.
 */

const GROUP_ROWS = `WHERE id = $1 OR id LIKE $2`;
const groupParams = (base: string) => [base, `${base}--%`];
const suffix = (id: string) => Number(id.split("--")[1] ?? 1);

/** The highest row number a group has ever used, including deleted rows. */
export async function maxGroupSuffix(type: StoredResourceType, base: string): Promise<number> {
  const rows = await sql.unsafe(
    `SELECT DISTINCT id FROM ${tableName(type)}_history ${GROUP_ROWS}`,
    groupParams(base),
  );
  return [...rows].reduce((max: number, r: any) => Math.max(max, suffix(r.id)), 1);
}

/** All current rows of a group, by row number. */
export async function readGroup(type: StoredResourceType, base: string): Promise<StoredResource[]> {
  const rows = await sql.unsafe(`SELECT id, resource FROM ${tableName(type)} ${GROUP_ROWS}`, groupParams(base));
  return [...rows]
    .sort((a: any, b: any) => suffix(a.id) - suffix(b.id))
    .map((r: any) => r.resource);
}

/**
 * Replaces a group's rows in one transaction: every given row gets a new version and any
 * row not given is deleted. `ifMatch` is checked against the row a client addressed.
 * `repoint` moves references from a row that is gone to the row its structure moved into.
 */
export async function writeGroup(
  type: StoredResourceType,
  base: string,
  rows: StoredResource[],
  ifMatch?: { id: string; version: number },
  repoint?: { from: string; to: string },
): Promise<StoredResource[]> {
  const t = tableName(type);
  return sql.begin(async (tx) => {
    const current: { id: string; version_id: number }[] = await tx.unsafe(
      `SELECT id, version_id FROM ${t} ${GROUP_ROWS} ORDER BY id FOR UPDATE`,
      groupParams(base),
    );
    if (ifMatch) {
      const addressed = current.find((r) => r.id === ifMatch.id);
      if (addressed?.version_id !== ifMatch.version) {
        throw new VersionConflict(
          `Version conflict: expected ${ifMatch.version}, current is ${addressed?.version_id ?? "none"}`,
        );
      }
    }
    const keep = new Set(rows.map((r) => r.id));
    for (const row of current) {
      if (!keep.has(row.id)) await deleteRow(tx, t, row.id, row.version_id);
    }
    const stored: StoredResource[] = [];
    for (const row of rows) stored.push(await writeRow(tx, t, row.id!, row));
    if (repoint) await repointBodySiteReferences(tx, repoint.from, repoint.to);
    return stored;
  });
}

/** Types that reference a BodyStructure through `bodySite.extension`. */
const BODY_SITE_REFERRERS: readonly StoredResourceType[] = ["Observation"];

/** Each changed resource gets a new version, in the caller's transaction. */
async function repointBodySiteReferences(tx: any, from: string, to: string): Promise<void> {
  const link = { url: BODY_SITE_URL, valueReference: { reference: `BodyStructure/${from}` } };
  for (const type of BODY_SITE_REFERRERS) {
    const t = tableName(type);
    const referrers: { id: string; resource: StoredResource }[] = await tx.unsafe(
      `SELECT id, resource FROM ${t} WHERE resource #> '{bodySite,extension}' @> jsonb_build_array($1::jsonb) ORDER BY id FOR UPDATE`,
      [link],
    );
    for (const { id, resource } of referrers) {
      await writeRow(tx, t, id, withBodySiteRepointed(resource, from, to));
    }
  }
}

/** Deletes every row of a group. Returns false if there was nothing to delete. */
export async function removeGroup(type: StoredResourceType, base: string): Promise<boolean> {
  const t = tableName(type);
  return sql.begin(async (tx) => {
    const current: { id: string; version_id: number }[] = await tx.unsafe(
      `SELECT id, version_id FROM ${t} ${GROUP_ROWS} FOR UPDATE`,
      groupParams(base),
    );
    for (const row of current) await deleteRow(tx, t, row.id, row.version_id);
    return current.length > 0;
  });
}

/** Returns false if there was nothing to delete. */
export async function remove(type: StoredResourceType, id: string): Promise<boolean> {
  const t = tableName(type);
  return sql.begin(async (tx) => {
    const [current] = await tx.unsafe(`DELETE FROM ${t} WHERE id = $1 RETURNING version_id`, [id]);
    if (!current) return false;
    await tx.unsafe(
      `INSERT INTO ${t}_history (id, version_id, last_updated, resource) VALUES ($1, $2, now(), NULL)`,
      [id, current.version_id + 1],
    );
    return true;
  });
}
