import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "../src/db/index.ts";
import { fixture, startServer, type TestServer } from "./helpers.ts";

const BODY_SITE = "http://hl7.org/fhir/StructureDefinition/bodySite";

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
}, 120_000);
afterAll(() => s.stop());

const link = (reference: string, more: Record<string, unknown> = {}) => ({
  url: BODY_SITE,
  valueReference: { reference, ...more },
});

const observation = (bodySite?: unknown, more: Record<string, unknown> = {}) => ({
  resourceType: "Observation",
  status: "final",
  code: { text: "Skin temperature" },
  ...(bodySite ? { bodySite } : {}),
  ...more,
});

async function create(body: unknown): Promise<any> {
  const res = await s.send("POST", "/R4/Observation", body);
  expect(res.status).toBe(201);
  return res.json();
}

const getR4 = async (id: string): Promise<any> => (await s.send("GET", `/R4/Observation/${id}`)).json();

async function getR6(id: string): Promise<any> {
  const res = await s.send("GET", `/R6/Observation/${id}`);
  expect(res.status).toBe(200);
  return res.json();
}

const r6Errors = (resource: any) =>
  (s.validators.R6.validate(resource).issue ?? []).filter((i: any) => i.severity === "error" || i.severity === "fatal");

const links = (r4: any) => r4.bodySite.extension.filter((e: any) => e.url === BODY_SITE).map((e: any) => e.valueReference.reference);

/** A BodyStructure with structures Forearm, Upper arm and Shoulder in rows id, id--2 and id--3. */
async function createGroup(): Promise<string> {
  const res = await s.send("POST", "/R6/BodyStructure", await fixture("multi"));
  expect(res.status).toBe(201);
  return ((await res.json()) as any).id;
}

const readGroupR6 = async (id: string): Promise<any> => (await s.send("GET", `/R6/BodyStructure/${id}`)).json();

async function removeFirstStructure(id: string, headers: Record<string, string> = {}) {
  const r6 = await readGroupR6(id);
  r6.includedStructure.shift();
  return s.send("PUT", `/R6/BodyStructure/${id}`, r6, headers);
}

describe("R4 bodySite extension and R6 bodyStructure", () => {
  test("a row reference is stored as sent in R4 and is the whole resource in R6", async () => {
    const sent = { text: "arm", extension: [link("BodyStructure/abc--2", { display: "Upper arm" })] };
    const { id } = await create(observation(sent));

    expect((await getR4(id)).bodySite).toEqual(sent);

    const r6 = await getR6(id);
    expect(r6.bodyStructure).toEqual([{ reference: { reference: "BodyStructure/abc", display: "Upper arm" } }]);
    expect(r6.bodySite).toEqual({ text: "arm" });
    expect(r6Errors(r6)).toEqual([]);
  });

  test("rows of one group become one reference, and different groups stay apart", async () => {
    const { id } = await create(observation({
      extension: [link("BodyStructure/abc--2"), link("BodyStructure/abc--3"), link("BodyStructure/abc"), link("BodyStructure/def")],
    }));
    const r6 = await getR6(id);
    expect(r6.bodyStructure.map((b: any) => b.reference.reference)).toEqual(["BodyStructure/abc", "BodyStructure/def"]);
    expect(r6Errors(r6)).toEqual([]);
  });

  test("identifier-only references are never merged", async () => {
    const reference = (value: string) => ({ url: BODY_SITE, valueReference: { identifier: { system: "http://example.org", value } } });
    const { id } = await create(observation({ extension: [reference("a"), reference("b")] }));
    const r6 = await getR6(id);
    expect(r6.bodyStructure.map((b: any) => b.reference.identifier.value)).toEqual(["a", "b"]);
    expect(r6Errors(r6)).toEqual([]);
  });

  test("a bodySite holding only the extension has no R6 bodySite", async () => {
    const { id } = await create(observation({ extension: [link("BodyStructure/abc")] }));
    const r6 = await getR6(id);
    expect(r6.bodySite).toBeUndefined();
    expect(r6.bodyStructure).toEqual([{ reference: { reference: "BodyStructure/abc" } }]);
  });

  test("a coded bodySite is unchanged and adds no bodyStructure", async () => {
    const bodySite = { coding: [{ system: "http://snomed.info/sct", code: "368208006" }] };
    const r6 = await getR6((await create(observation(bodySite))).id);
    expect(r6.bodySite).toEqual(bodySite);
    expect(r6.bodyStructure).toBeUndefined();
  });

  test("an Observation with no bodySite has neither element", async () => {
    const r6 = await getR6((await create(observation())).id);
    expect(r6.bodySite).toBeUndefined();
    expect(r6.bodyStructure).toBeUndefined();
  });

  test("other extensions stay on bodySite, and an extension on the reference is kept", async () => {
    const other = { url: "http://example.org/other", valueString: "keep" };
    const onReference = { url: "http://example.org/on-reference", valueString: "keep too" };
    const { id } = await create(observation({
      extension: [other, link("BodyStructure/abc--2", { extension: [onReference] })],
    }));
    const r6 = await getR6(id);
    expect(r6.bodySite).toEqual({ extension: [other] });
    expect(r6.bodyStructure).toEqual([{ reference: { reference: "BodyStructure/abc", extension: [onReference] } }]);
  });

  test("an external reference that looks like a row passes through unchanged", async () => {
    const external = "https://other.example.org/fhir/BodyStructure/abc--2";
    const { id } = await create(observation({ extension: [link(external)] }));
    expect((await getR6(id)).bodyStructure).toEqual([{ reference: { reference: external } }]);
  });

  test("the R6 reference can be followed to every structure, and an R4 row reference to its own", async () => {
    const group = await createGroup();
    const { id } = await create(observation({ extension: [link(`BodyStructure/${group}--2`)] }));

    const r4Reference = links(await getR4(id))[0];
    const row: any = await (await s.send("GET", `/R4/${r4Reference}`)).json();
    expect(row.location.text).toBe("Upper arm");

    const r6Reference = (await getR6(id)).bodyStructure[0].reference.reference;
    const res = await s.send("GET", `/R6/${r6Reference}`);
    expect(res.status).toBe(200);
    const whole: any = await res.json();
    expect(whole.includedStructure.map((i: any) => i.structure.text)).toEqual(["Forearm", "Upper arm", "Shoulder"]);
  });
});

describe("a structure moves into the primary row", () => {
  test("references to its old row follow it, as new versions", async () => {
    const group = await createGroup();
    const moved = await create(observation({ text: "arm", extension: [link(`BodyStructure/${group}--2`, { display: "Upper arm" })] }));

    expect((await removeFirstStructure(group)).status).toBe(200);

    const after = await getR4(moved.id);
    expect(after.bodySite).toEqual({ text: "arm", extension: [link(`BodyStructure/${group}`, { display: "Upper arm" })] });
    expect(after.meta.versionId).toBe("2");

    const history = await sql.unsafe(`SELECT version_id, resource FROM observation_history WHERE id = $1 ORDER BY version_id`, [moved.id]);
    expect(history.map((r: any) => r.version_id)).toEqual([1, 2]);
    expect(links(history[0].resource)).toEqual([`BodyStructure/${group}--2`]);
    expect(links(history[1].resource)).toEqual([`BodyStructure/${group}`]);

    expect((await s.send("GET", `/R4/BodyStructure/${group}--2`)).status).toBe(410);
    const target: any = await (await s.send("GET", `/R4/${links(after)[0]}`)).json();
    expect(target.location.text).toBe("Upper arm");
    expect((await getR6(moved.id)).bodyStructure[0].reference.reference).toBe(`BodyStructure/${group}`);
  });

  test("a client that sends no element ids moves the structure too", async () => {
    const group = await createGroup();
    const obs = await create(observation({ extension: [link(`BodyStructure/${group}--2`)] }));

    const r6 = await readGroupR6(group);
    r6.includedStructure = r6.includedStructure.slice(1).map(({ id: _id, ...structure }: any) => structure);
    expect((await s.send("PUT", `/R6/BodyStructure/${group}`, r6)).status).toBe(200);

    expect(links(await getR4(obs.id))).toEqual([`BodyStructure/${group}`]);
  });

  test("other references aren't touched", async () => {
    const group = await createGroup();
    const unrelated = await createGroup();
    const third = await create(observation({ extension: [link(`BodyStructure/${group}--3`)] }));
    const other = await create(observation({ extension: [link(`BodyStructure/${unrelated}--2`)] }));
    const similar = await create(observation({ extension: [link(`BodyStructure/${group}--22`)] }));

    expect((await removeFirstStructure(group)).status).toBe(200);

    for (const untouched of [third, other, similar]) {
      const after = await getR4(untouched.id);
      expect(after.meta.versionId).toBe("1");
      expect(after.bodySite).toEqual(untouched.bodySite);
    }
  });

  test("an Observation that also references the primary row isn't left with a repeat", async () => {
    const group = await createGroup();
    const both = await create(observation({
      extension: [link(`BodyStructure/${group}`), link(`BodyStructure/${group}--2`), link(`BodyStructure/${group}--3`)],
    }));

    expect((await removeFirstStructure(group)).status).toBe(200);

    expect(links(await getR4(both.id))).toEqual([`BodyStructure/${group}`, `BodyStructure/${group}--3`]);
  });

  test("a structure that moved already can't move the reference again by mistake", async () => {
    const group = await createGroup();
    const obs = await create(observation({ extension: [link(`BodyStructure/${group}--2`)] }));

    expect((await removeFirstStructure(group)).status).toBe(200);
    expect((await removeFirstStructure(group)).status).toBe(200);

    expect(links(await getR4(obs.id))).toEqual([`BodyStructure/${group}`]);
    const after = await getR4(obs.id);
    expect(after.meta.versionId).toBe("2");
    expect(((await readGroupR6(group)) as any).includedStructure.map((i: any) => i.structure.text)).toEqual(["Shoulder"]);
  });
});

describe("no structure moves, so nothing is rewritten", () => {
  const unchangedAfter = async (reference: (group: string) => string, change: (group: string) => Promise<Response>, status: number) => {
    const group = await createGroup();
    const obs = await create(observation({ extension: [link(reference(group))] }));
    expect((await change(group)).status).toBe(status);
    const after = await getR4(obs.id);
    expect(after.meta.versionId).toBe("1");
    expect(after.bodySite).toEqual(obs.bodySite);
  };

  test("removing a later structure through R6: its reference dangles", async () => {
    await unchangedAfter((g) => `BodyStructure/${g}--3`, async (g) => {
      const r6 = await readGroupR6(g);
      r6.includedStructure.pop();
      return s.send("PUT", `/R6/BodyStructure/${g}`, r6);
    }, 200);
  });

  test("replacing the first structure with new content, and no element id", async () => {
    await unchangedAfter((g) => `BodyStructure/${g}--2`, async (g) => {
      const r6 = await readGroupR6(g);
      r6.includedStructure[0] = { structure: { text: "Ankle" } };
      return s.send("PUT", `/R6/BodyStructure/${g}`, r6);
    }, 200);
  });

  test("reordering structures", async () => {
    await unchangedAfter((g) => `BodyStructure/${g}--2`, async (g) => {
      const r6 = await readGroupR6(g);
      r6.includedStructure.reverse();
      return s.send("PUT", `/R6/BodyStructure/${g}`, r6);
    }, 200);
  });

  test("an R4 update of a row", async () => {
    await unchangedAfter((g) => `BodyStructure/${g}--2`, async (g) => {
      const row: any = await (await s.send("GET", `/R4/BodyStructure/${g}--2`)).json();
      return s.send("PUT", `/R4/BodyStructure/${g}--2`, { ...row, description: "edited" });
    }, 200);
  });

  test("an R4 delete of a row or of the group: references dangle", async () => {
    await unchangedAfter((g) => `BodyStructure/${g}--2`, (g) => s.send("DELETE", `/R4/BodyStructure/${g}--2`), 204);
    await unchangedAfter((g) => `BodyStructure/${g}--2`, (g) => s.send("DELETE", `/R4/BodyStructure/${g}`), 204);
  });

  test("a move rejected by If-Match rewrites nothing", async () => {
    await unchangedAfter((g) => `BodyStructure/${g}--2`, (g) => removeFirstStructure(g, { "if-match": 'W/"99"' }), 412);
  });

  test("a move rejected as invalid rewrites nothing", async () => {
    await unchangedAfter((g) => `BodyStructure/${g}--2`, async (g) => {
      const r6 = await readGroupR6(g);
      r6.includedStructure.shift();
      r6.status = "not-an-element";
      return s.send("PUT", `/R6/BodyStructure/${g}`, r6);
    }, 422);
  });
});

describe("the form of a bodySite reference", () => {
  const rejected: Record<string, (origin: string) => unknown> = {
    "no valueReference": () => ({ url: BODY_SITE, valueString: "BodyStructure/abc" }),
    "another resource type": () => link("Patient/abc"),
    "a type that isn't BodyStructure": () => link("BodyStructure/abc", { type: "Patient" }),
    "version-specific": () => link("BodyStructure/abc/_history/1"),
    "contained": () => link("#abc"),
    "absolute on this server": (origin) => link(`${origin}/R4/BodyStructure/abc--2`),
    "absolute to something else": () => link("https://other.example.org/fhir/Patient/abc"),
  };

  const origin = async () => {
    const res = await s.send("GET", "/R4/metadata");
    return new URL(res.url).origin;
  };

  for (const [name, extension] of Object.entries(rejected)) {
    test(`${name} returns 422 on create, and on update`, async () => {
      const body = observation({ extension: [extension(await origin())] });
      const res = await s.send("POST", "/R4/Observation", body);
      expect(res.status).toBe(422);
      expect(((await res.json()) as any).resourceType).toBe("OperationOutcome");

      const { id } = await create(observation());
      expect((await s.send("PUT", `/R4/Observation/${id}`, { ...body, id })).status).toBe(422);
      expect((await getR4(id)).meta.versionId).toBe("1");
    });
  }

  test("external absolute and identifier-only references are accepted, and the target need not exist", async () => {
    await create(observation({ extension: [link("https://other.example.org/fhir/BodyStructure/abc")] }));
    await create(observation({ extension: [{ url: BODY_SITE, valueReference: { identifier: { value: "abc" } } }] }));
    await create(observation({ extension: [link(`BodyStructure/${crypto.randomUUID()}`)] }));
  });
});

describe("Observation through both versions", () => {
  test("R6 is read-only", async () => {
    const { id } = await create(observation());
    const r6 = await getR6(id);
    expect((await s.send("POST", "/R6/Observation", r6)).status).toBe(405);
    expect((await s.send("PUT", `/R6/Observation/${id}`, r6)).status).toBe(405);
    expect((await s.send("DELETE", `/R6/Observation/${id}`)).status).toBe(405);
  });

  test("R4 update and delete work, and the deleted resource returns 410 in both versions", async () => {
    const { id } = await create(observation());
    const updated = await s.send("PUT", `/R4/Observation/${id}`, { ...observation({ text: "hand" }), id });
    expect(updated.status).toBe(200);
    expect((await getR6(id)).bodySite).toEqual({ text: "hand" });
    expect((await s.send("DELETE", `/R4/Observation/${id}`)).status).toBe(204);
    expect((await s.send("GET", `/R4/Observation/${id}`)).status).toBe(410);
    expect((await s.send("GET", `/R6/Observation/${id}`)).status).toBe(410);
  });

  test("realistic Observations convert to valid R6", async () => {
    const realistic = [
      { effectiveDateTime: "2026-01-01", valueQuantity: { value: 37.5, unit: "C", system: "http://unitsofmeasure.org", code: "Cel" }, referenceRange: [{ low: { value: 1.5 }, text: "r" }] },
      { effectivePeriod: { start: "2026-01-01" }, valueCodeableConcept: { text: "positive" }, performer: [{ reference: "Practitioner/1" }], note: [{ text: "n" }] },
      { valueString: "s", hasMember: [{ reference: "Observation/2" }], derivedFrom: [{ reference: "Observation/3" }] },
      { component: [{ code: { text: "systolic" }, valueQuantity: { value: 120, unit: "mmHg" } }, { code: { text: "diastolic" }, valueInteger: 80 }] },
    ];
    for (const more of realistic) {
      const r6 = await getR6((await create(observation(undefined, more))).id);
      expect(r6Errors(r6)).toEqual([]);
      for (const [key, value] of Object.entries(more)) expect(r6[key]).toEqual(value);
    }
  });

  test("the CapabilityStatement lists Observation as read-only in R6", async () => {
    const statement = async (version: string): Promise<any> => (await s.send("GET", `/${version}/metadata`)).json();
    const interactions = async (version: string) =>
      (await statement(version)).rest[0].resource.find((r: any) => r.type === "Observation").interaction.map((i: any) => i.code);
    expect(await interactions("R4")).toEqual(["read", "create", "update", "delete"]);
    expect(await interactions("R6")).toEqual(["read"]);
  });
});
