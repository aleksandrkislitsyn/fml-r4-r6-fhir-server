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
    const [last] = await tx.unsafe(
      `SELECT max(version_id) AS v FROM ${t}_history WHERE id = $1`,
      [id],
    );
    // Lock the current row so concurrent updates serialize.
    const [current] = await tx.unsafe(`SELECT version_id FROM ${t} WHERE id = $1 FOR UPDATE`, [id]);
    if (ifMatch !== undefined && current?.version_id !== ifMatch) {
      throw new VersionConflict(
        `Version conflict: expected ${ifMatch}, current is ${current?.version_id ?? "none"}`,
      );
    }
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
