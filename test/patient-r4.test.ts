import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { migrate, sql } from "../src/db/index.ts";
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
  await sql.close();
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

  test("R6 Patient is not implemented yet", async () => {
    const res = await fetch(`${server.url}R6/Patient/x`);
    expect(res.status).toBe(501);
  });

  test("metadata", async () => {
    const res = await send("GET", "/metadata");
    expect(res.status).toBe(200);
    const metadata = (await res.json()) as any;
    expect(metadata.fhirVersion).toBe("4.0.1");
    expect(metadata.rest[0].resource.map((r: any) => r.type)).toContain("Encounter");
  });
});

describe("R4 Encounter", () => {
  const encounter = {
    resourceType: "Encounter",
    status: "in-progress",
    class: {
      system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      code: "AMB",
    },
    extension: [{
      url: "xver/encounter-class",
      valueCodeableConcept: {
        coding: [{
          system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
          code: "VR",
        }],
      },
    }],
  };

  test("create and read preserve native class and cross-version extension", async () => {
    const response = await send("POST", "/Encounter", encounter);
    expect(response.status).toBe(201);
    const created = (await response.json()) as any;
    try {
      const read = await send("GET", `/Encounter/${created.id}`);
      expect(read.status).toBe(200);
      const stored = (await read.json()) as any;
      expect(stored.class).toEqual(encounter.class);
      expect(stored.extension).toEqual(encounter.extension);
    } finally {
      await send("DELETE", `/Encounter/${created.id}`);
    }
  });

  test("R4 class remains required", async () => {
    const { class: _class, ...invalid } = encounter;
    const response = await send("POST", "/Encounter", invalid);
    expect(response.status).toBe(422);
    expect(((await response.json()) as any).resourceType).toBe("OperationOutcome");
  });

  test("class search matches native Coding, respects system, and excludes extensions and deleted resources", async () => {
    const system = `https://example.org/class/${crypto.randomUUID()}`;
    const fixtures = [
      { ...encounter, class: { system, code: "AMB" } },
      { ...encounter, class: { system: `${system}/other`, code: "AMB" } },
      {
        ...encounter,
        class: { system, code: "VR" },
        extension: [{ url: "xver/encounter-class", valueCodeableConcept: { coding: [{ system, code: "AMB" }] } }],
      },
      { resourceType: "Encounter", status: "in-progress", class: { code: `no-system-${crypto.randomUUID()}` } },
    ];
    const ids: string[] = [];
    const search = async (value: string) => {
      const response = await send("GET", `/Encounter?${new URLSearchParams({ class: value })}`);
      expect(response.status).toBe(200);
      return (await response.json()) as any;
    };
    const matches = (bundle: any) => bundle.entry.map((e: any) => e.resource.id);
    try {
      for (const fixture of fixtures) {
        const response = await send("POST", "/Encounter", fixture);
        expect(response.status).toBe(201);
        ids.push(((await response.json()) as any).id);
      }
      const exact = await search(`${system}|AMB`);
      expect(exact.resourceType).toBe("Bundle");
      expect(exact.type).toBe("searchset");
      expect(exact.total).toBe(1);
      expect(matches(exact)).toEqual([ids[0]]);
      expect(exact.entry[0].fullUrl).toBe(`${base}/Encounter/${ids[0]}`);
      expect(exact.entry[0].search.mode).toBe("match");
      expect(new URL(exact.link[0].url).searchParams.get("class")).toBe(`${system}|AMB`);

      const codeOnly = matches(await search("AMB"));
      expect(codeOnly).toContain(ids[0]);
      expect(codeOnly).toContain(ids[1]);
      expect(codeOnly).not.toContain(ids[2]);
      expect(matches(await search(`${system}|`)).sort()).toEqual([ids[0]!, ids[2]!].sort());
      expect(matches(await search(`|${fixtures[3]!.class.code}`))).toEqual([ids[3]]);

      expect((await send("DELETE", `/Encounter/${ids[0]}`)).status).toBe(204);
      const empty = await search(`${system}|AMB`);
      expect(empty.total).toBe(0);
      expect(empty.entry).toEqual([]);

      const list = await send("GET", "/Encounter");
      expect(list.status).toBe(200);
      expect(matches(await list.json())).toContain(ids[2]);
    } finally {
      for (const id of ids) await send("DELETE", `/Encounter/${id}`);
    }
  });

  test("unsupported and malformed class queries return OperationOutcome", async () => {
    for (const query of ["class=", "class=%7C", "class=a%7Cb%7Cc", "class=AMB,VR", "class=AMB&class=VR", "class:text=ambulatory", "status=in-progress"]) {
      const response = await send("GET", `/Encounter?${query}`);
      expect(response.status).toBe(400);
      expect(((await response.json()) as any).resourceType).toBe("OperationOutcome");
    }
  });

  test("metadata advertises Encounter class search only", async () => {
    const response = await send("GET", "/metadata");
    const metadata = (await response.json()) as any;
    const resources = metadata.rest[0].resource;
    const advertised = resources.find((r: any) => r.type === "Encounter");
    expect(advertised.interaction).toContainEqual({ code: "search-type" });
    expect(advertised.searchParam).toContainEqual(expect.objectContaining({ name: "class", type: "token" }));
    expect(resources.find((r: any) => r.type === "Patient").interaction).not.toContainEqual({ code: "search-type" });
  });
});

describe("R6 Encounter read facade", () => {
  let r6: Awaited<ReturnType<typeof loadValidator>>;
  beforeAll(async () => { r6 = await loadValidator("R6"); }, 120_000);
  const getR6 = (path: string) => fetch(`${base.replace(/R4$/, "R6")}${path}`);

  test("class search finds extension codings and executes FML to return a valid R6 Encounter", async () => {
    const system = `https://example.org/r6-class/${crypto.randomUUID()}`;
    const fixture = {
      resourceType: "Encounter", status: "in-progress",
      class: { system, code: "AMB" },
      period: { start: "2026-11-06T10:00:00Z" },
      extension: [{
        url: "xver/encounter-class",
        valueCodeableConcept: { coding: [
          { system, code: "VR" },
          { system: `${system}/other`, code: "IMP" },
        ], text: "Virtual encounter" },
      }],
    };
    const created = await send("POST", "/Encounter", fixture);
    expect(created.status).toBe(201);
    const saved = (await created.json()) as any;
    const query = (value: string) => `/Encounter?${new URLSearchParams({ class: value })}`;
    try {
      const native = await send("GET", query(`${system}|VR`));
      expect(((await native.json()) as any).total).toBe(0);
      const response = await getR6(query(`${system}|VR`));
      expect(response.status).toBe(200);
      const bundle = (await response.json()) as any;
      expect(bundle.total).toBe(1);
      expect(bundle.entry[0].fullUrl).toBe(`${base.replace(/R4$/, "R6")}/Encounter/${saved.id}`);
      const converted = bundle.entry[0].resource;
      expect(converted.id).toBe(saved.id);
      expect(converted.meta).toEqual(saved.meta);
      expect(converted.class).toEqual([
        { coding: [fixture.class] }, fixture.extension[0]!.valueCodeableConcept,
      ]);
      expect(converted.actualPeriod).toEqual(fixture.period);
      expect(converted.period).toBeUndefined();
      expect(converted.extension).toBeUndefined();
      const errors = (r6.validate(converted).issue ?? []).filter((issue) => issue.severity === "error" || issue.severity === "fatal");
      expect(errors).toEqual([]);

      const read = await getR6(`/Encounter/${saved.id}`);
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual(converted);
      const wrongPair = await getR6(query(`${system}/other|VR`));
      expect(((await wrongPair.json()) as any).total).toBe(0);
      const nativeR6 = await getR6(query(`${system}|AMB`));
      expect(((await nativeR6.json()) as any).total).toBe(1);
      const codeOnly = await getR6(query("VR"));
      expect(((await codeOnly.json()) as any).entry.map((e: any) => e.resource.id)).toContain(saved.id);
      const rereadR4 = await send("GET", `/Encounter/${saved.id}`);
      expect(((await rereadR4.json()) as any).extension).toEqual(fixture.extension);
    } finally {
      await send("DELETE", `/Encounter/${saved.id}`);
    }
    const deleted = await getR6(query(`${system}|VR`));
    expect(((await deleted.json()) as any).total).toBe(0);
  });

  test("a resource matching native and extension class is returned once", async () => {
    const system = `https://example.org/r6-duplicate/${crypto.randomUUID()}`;
    const coding = { system, code: "VR" };
    const response = await send("POST", "/Encounter", {
      resourceType: "Encounter", status: "in-progress", class: coding,
      extension: [{ url: "xver/encounter-class", valueCodeableConcept: { coding: [coding] } }],
    });
    expect(response.status).toBe(201);
    const saved = (await response.json()) as any;
    try {
      const result = await getR6(`/Encounter?${new URLSearchParams({ class: `${system}|VR` })}`);
      expect(result.status).toBe(200);
      expect(((await result.json()) as any).total).toBe(1);
    } finally { await send("DELETE", `/Encounter/${saved.id}`); }
  });

  test("R6 metadata advertises read/search only and unsupported writes remain disabled", async () => {
    const response = await getR6("/metadata");
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as any;
    expect(metadata.fhirVersion).toBe("6.0.0-ballot5");
    expect(metadata.rest[0].resource).toHaveLength(1);
    expect(metadata.rest[0].resource[0].interaction).toEqual([{ code: "read" }, { code: "search-type" }]);
    expect((await fetch(`${base.replace(/R4$/, "R6")}/Encounter`, { method: "POST" })).status).toBe(501);
    expect((await fetch(`${base.replace(/R4$/, "R6")}/Encounter/anything`, { method: "DELETE" })).status).toBe(501);
    expect((await getR6("/Patient/anything")).status).toBe(501);
    expect((await getR6("/Encounter?class:text=virtual")).status).toBe(400);
  });
});
