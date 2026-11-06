import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { migrate } from "../src/db/index.ts";
import { hasErrors, loadValidator } from "../src/fhir/validator.ts";
import { createHandler } from "../src/http/server.ts";
import { createFmlConverter } from "../src/fhir/convert.ts";
import type { Patient } from "../src/fhir-types/hl7-fhir-r4-core/Patient.ts";

let server: ReturnType<typeof Bun.serve>;
let base: string;

const CLASS_EXTENSION = "http://hl7.org/fhir/6.0/StructureDefinition/extension-Encounter.class";

beforeAll(async () => {
  await migrate();
  const r4 = await loadValidator("R4");
  server = Bun.serve({ port: 0, fetch: createHandler({ validators: { R4: r4 }, converter: createFmlConverter() }) });
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
  test("id and extension are legal on backbone elements", async () => {
    const res = await send("POST", "/Patient", {
      ...patient,
      contact: [{ id: "c1", extension: [{ url: "http://example.org/x", valueBoolean: true }], name: { family: "Roe" } }],
    });
    expect(res.status).toBe(201);
  });

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

    const r6Read = await fetch(`${server.url}R6/Patient/${c.id}`);
    expect(r6Read.status).toBe(200);
    const r6Patient = (await r6Read.json()) as Patient;
    expect(r6Patient.id).toBe(c.id);
    expect(r6Patient.meta).toEqual(c.meta);
    expect(r6Patient.name).toEqual(patient.name);

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

  test("R6 reads carry string and CodeableConcept extensions", async () => {
    const extension = [
      { url: "http://example.org/s", valueString: "text" },
      { url: "http://example.org/c", valueCodeableConcept: { text: "concept" } },
    ];
    const created = await send("POST", "/Patient", { ...patient, extension });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as Patient;
    const read = await fetch(`${server.url}R6/Patient/${id}`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as any).extension).toEqual(extension);
  });

  test("R6 Patient reads return 404 for unknown ids", async () => {
    const res = await fetch(`${server.url}R6/Patient/x`);
    expect(res.status).toBe(404);
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
      url: CLASS_EXTENSION,
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
        extension: [{ url: CLASS_EXTENSION, valueCodeableConcept: { coding: [{ system, code: "AMB" }] } }],
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

  test("class-r6 backports R6 class search: native Coding plus extension codings, each Encounter once", async () => {
    const system = `https://example.org/class-r6/${crypto.randomUUID()}`;
    const withClass = (code: string, extension: object) => ({ ...encounter, class: { system, code }, extension: [extension] });
    const fixtures = [
      withClass("AMB", { url: CLASS_EXTENSION, valueCodeableConcept: { coding: [{ system, code: "VR" }] } }),
      withClass("VR", { url: CLASS_EXTENSION, valueCodeableConcept: { coding: [{ system, code: "VR" }] } }),
      withClass("IMP", { url: CLASS_EXTENSION, valueCodeableConcept: { coding: [{ system: `${system}/other`, code: "VR" }] } }),
      withClass("EMER", { url: "https://example.org/other-extension", valueCodeableConcept: { coding: [{ system, code: "VR" }] } }),
    ];
    const ids: string[] = [];
    const search = async (params: Record<string, string>) => {
      const response = await send("GET", `/Encounter?${new URLSearchParams(params)}`);
      expect(response.status).toBe(200);
      return (await response.json()) as any;
    };
    const matches = (bundle: any) => bundle.entry.map((e: any) => e.resource.id).sort();
    try {
      for (const fixture of fixtures) {
        const response = await send("POST", "/Encounter", fixture);
        expect(response.status).toBe(201);
        ids.push(((await response.json()) as any).id);
      }
      const backport = await search({ "class-r6": `${system}|VR` });
      expect(backport.type).toBe("searchset");
      expect(backport.total).toBe(2);
      expect(matches(backport)).toEqual([ids[0]!, ids[1]!].sort());
      const first = backport.entry.find((e: any) => e.resource.id === ids[0]).resource;
      expect(first.class).toEqual(fixtures[0]!.class);
      expect(first.extension).toEqual(fixtures[0]!.extension);

      expect(matches(await search({ class: `${system}|VR` }))).toEqual([ids[1]]);
      expect(matches(await search({ "class-r6": `${system}|IMP` }))).toEqual([ids[2]]);
      expect(matches(await search({ "class-r6": `${system}/other|VR` }))).toEqual([ids[2]]);
    } finally {
      for (const id of ids) await send("DELETE", `/Encounter/${id}`);
    }
  });

  test("unsupported and malformed class queries return OperationOutcome", async () => {
    for (const query of [
      "class=", "class=%7C", "class=a%7Cb%7Cc", "class=AMB,VR", "class=AMB&class=VR", "class:text=ambulatory", "status=in-progress",
      "class-r6=", "class-r6=AMB&class-r6=VR", "class=AMB&class-r6=VR",
    ]) {
      const response = await send("GET", `/Encounter?${query}`);
      expect(response.status).toBe(400);
      expect(((await response.json()) as any).resourceType).toBe("OperationOutcome");
    }
  });

  test("metadata advertises class and its R6 backport for Encounter only", async () => {
    const response = await send("GET", "/metadata");
    const metadata = (await response.json()) as any;
    const resources = metadata.rest[0].resource;
    const advertised = resources.find((r: any) => r.type === "Encounter");
    expect(advertised.interaction).toContainEqual({ code: "search-type" });
    expect(advertised.searchParam).toContainEqual(expect.objectContaining({
      name: "class", type: "token", definition: "http://hl7.org/fhir/SearchParameter/Encounter-class",
    }));
    expect(advertised.searchParam).toContainEqual(expect.objectContaining({
      name: "class-r6", type: "token", definition: "http://example.org/fhir/SearchParameter/Encounter-class-r6",
    }));
    expect(resources.find((r: any) => r.type === "Patient").interaction).not.toContainEqual({ code: "search-type" });
  });
});

describe("class-r6 SearchParameter definition", () => {
  let r4: Awaited<ReturnType<typeof loadValidator>>;
  beforeAll(async () => { r4 = await loadValidator("R4"); }, 120_000);

  test("is served from the canonical manager and is a valid R4 SearchParameter", async () => {
    const response = await send("GET", "/SearchParameter/Encounter-class-r6");
    expect(response.status).toBe(200);
    const sp = (await response.json()) as any;
    expect(sp).toMatchObject({
      resourceType: "SearchParameter",
      id: "Encounter-class-r6",
      url: "http://example.org/fhir/SearchParameter/Encounter-class-r6",
      code: "class-r6",
      base: ["Encounter"],
      type: "token",
    });
    expect(sp.expression).toBe(`Encounter.class | Encounter.extension('${CLASS_EXTENSION}').value`);
    expect(hasErrors(r4.validate(sp))).toBe(false);
    const known = await r4.definitions.getSearchParametersForResource("Encounter");
    expect(known.map((p: any) => p.code)).toContain("class-r6");
  });

  test("every Encounter searchParam definition in R4 metadata resolves", async () => {
    const metadata = (await (await send("GET", "/metadata")).json()) as any;
    const params = metadata.rest[0].resource.find((r: any) => r.type === "Encounter").searchParam;
    for (const param of params) {
      const id = param.definition.split("/").pop();
      const response = await send("GET", `/SearchParameter/${id}`);
      expect(response.status).toBe(200);
      const sp = (await response.json()) as any;
      expect(sp.url).toBe(param.definition);
      expect(sp.code).toBe(param.name);
    }
  });

  test("unknown SearchParameter returns 404", async () => {
    expect((await send("GET", "/SearchParameter/does-not-exist")).status).toBe(404);
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
        url: CLASS_EXTENSION,
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
      extension: [{ url: CLASS_EXTENSION, valueCodeableConcept: { coding: [coding] } }],
    });
    expect(response.status).toBe(201);
    const saved = (await response.json()) as any;
    try {
      const result = await getR6(`/Encounter?${new URLSearchParams({ class: `${system}|VR` })}`);
      expect(result.status).toBe(200);
      expect(((await result.json()) as any).total).toBe(1);
    } finally { await send("DELETE", `/Encounter/${saved.id}`); }
  });

  test("R6 metadata advertises search, and R6 writes need the R6 validator", async () => {
    const response = await getR6("/metadata");
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as any;
    expect(metadata.fhirVersion).toBe("6.0.0-ballot5");
    const encounter = metadata.rest[0].resource.find((r: any) => r.type === "Encounter");
    expect(encounter.interaction).toContainEqual({ code: "search-type" });
    expect(encounter.searchParam.map((p: any) => p.name)).toEqual(["class"]);
    // This server has no R6 validator, so it can't check R6 writes (test/r6-writes.test.ts has one).
    expect((await fetch(`${base.replace(/R4$/, "R6")}/Encounter`, { method: "POST", body: "{}" })).status).toBe(501);
    expect((await getR6("/Patient/anything")).status).toBe(404);
    expect((await getR6("/Encounter?class:text=virtual")).status).toBe(400);
    expect((await getR6("/Encounter?class-r6=VR")).status).toBe(400);
  });
});
