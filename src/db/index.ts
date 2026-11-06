import { SQL } from "bun";

export const sql = new SQL(
  process.env.DATABASE_URL ?? "postgres://fhir:fhir@localhost:5437/fhir",
);

/** Resource types that have a storage table. Add a type here to get a table for it. */
export const STORED_RESOURCE_TYPES = ["Patient", "BodyStructure"] as const;
export type StoredResourceType = (typeof STORED_RESOURCE_TYPES)[number];

export function isStoredResourceType(t: string): t is StoredResourceType {
  return (STORED_RESOURCE_TYPES as readonly string[]).includes(t);
}

/** One table per resource type: `patient`, plus `patient_history` for versions. */
export function tableName(type: StoredResourceType): string {
  return type.toLowerCase();
}

export async function migrate(): Promise<void> {
  for (const type of STORED_RESOURCE_TYPES) {
    const t = tableName(type);
    // Current version of each resource. Content is stored as FHIR R4 JSON.
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${t} (
        id           text PRIMARY KEY,
        version_id   integer NOT NULL,
        last_updated timestamptz NOT NULL DEFAULT now(),
        resource     jsonb NOT NULL
      )`);
    // Every version, including deletes (resource is NULL for a delete).
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${t}_history (
        id           text NOT NULL,
        version_id   integer NOT NULL,
        last_updated timestamptz NOT NULL,
        resource     jsonb,
        PRIMARY KEY (id, version_id)
      )`);
  }
}

if (import.meta.main) {
  await migrate();
  console.log("migrations applied");
  await sql.close();
}
