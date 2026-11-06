import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { migrate } from "../src/db/index.ts";
import { loadValidator } from "../src/fhir/validator.ts";
import { createHandler } from "../src/http/server.ts";
import type { Patient } from "../src/fhir-types/hl7-fhir-r4-core/Patient.ts";

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(async () => {
  await migrate();
  const r4 = await loadValidator("R4");
  server = Bun.serve({ port: 0, fetch: createHandler({ validators: { R4: r4 } }) });
  base = `${server.url}R4`;
}, 120_000);

afterAll(async () => {
  server.stop(true);
});

const patient: Patient = {
  resourceType: "Patient",
  name: [{ family: "Doe", given: ["Jane"] }],
  gender: "female",
  birthDate: "1990-04-01",
};

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/fhir+json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("R4 Patient CRUD", () => {
  test("create → read → update → delete", async () => {
    const created = await send("POST", "/Patient", { ...patient, id: "ignored" });
    expect(created.status).toBe(201);
    const c = (await created.json()) as Patient;
    expect(c.id).toBeString();
    expect(c.id).not.toBe("ignored");
    expect(c.meta?.versionId).toBe("1");
    expect(created.headers.get("etag")).toBe('W/"1"');
    expect(created.headers.get("location")).toBe(`${base}/Patient/${c.id}/_history/1`);

    const read = await send("GET", `/Patient/${c.id}`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as Patient).name?.[0]?.family).toBe("Doe");

    const updated = await send("PUT", `/Patient/${c.id}`, { ...c, gender: "other" }, { "if-match": 'W/"1"' });
    expect(updated.status).toBe(200);
    const u = (await updated.json()) as Patient;
    expect(u.meta?.versionId).toBe("2");
    expect(u.gender).toBe("other");

    const stale = await send("PUT", `/Patient/${c.id}`, c, { "if-match": 'W/"1"' });
    expect(stale.status).toBe(412);

    expect((await send("DELETE", `/Patient/${c.id}`)).status).toBe(204);
    expect((await send("GET", `/Patient/${c.id}`)).status).toBe(410);
    expect((await send("DELETE", `/Patient/${c.id}`)).status).toBe(204); // idempotent
  });

  test("PUT with a new id creates the resource", async () => {
    const id = `pt-${crypto.randomUUID()}`;
    const res = await send("PUT", `/Patient/${id}`, { ...patient, id });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Patient).id).toBe(id);
  });

  test("unknown id → 404", async () => {
    expect((await send("GET", "/Patient/does-not-exist")).status).toBe(404);
  });

  test("invalid resource → 422 with OperationOutcome", async () => {
    const res = await send("POST", "/Patient", { resourceType: "Patient", name: "not-an-array", foo: 1 });
    expect(res.status).toBe(422);
    const oo = (await res.json()) as any;
    expect(oo.resourceType).toBe("OperationOutcome");
    expect(oo.issue.length).toBeGreaterThan(0);
  });

  test("wrong resourceType → 400", async () => {
    expect((await send("POST", "/Patient", { resourceType: "Observation" })).status).toBe(400);
  });

  test("id mismatch on PUT → 400", async () => {
    expect((await send("PUT", "/Patient/a", { ...patient, id: "b" })).status).toBe(400);
  });

  test("R6 is not implemented yet", async () => {
    const res = await fetch(`${server.url}R6/Patient/x`);
    expect(res.status).toBe(501);
  });

  test("metadata", async () => {
    const res = await send("GET", "/metadata");
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).fhirVersion).toBe("4.0.1");
  });
});
