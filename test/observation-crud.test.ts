import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "../src/db/index.ts";
import { fixture, startServer, type TestServer } from "./helpers.ts";

const BODY_SITE = "http://hl7.org/fhir/StructureDefinition/bodySite";
const XVER = "http://hl7.org/fhir/6.0/StructureDefinition/extension-Observation";

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
}, 120_000);
afterAll(() => s.stop());

const base = { resourceType: "Observation", status: "final", code: { text: "Skin temperature" } };
const reference = (target: string, more: Record<string, unknown> = {}) => ({ reference: { reference: target, ...more } });
const link = (target: string, more: Record<string, unknown> = {}) => ({
  url: BODY_SITE,
  valueReference: { reference: target, ...more },
});

async function createR6(body: unknown): Promise<any> {
  const res = await s.send("POST", "/R6/Observation", body);
  expect(res.status).toBe(201);
  return res.json();
}
async function createR4(body: unknown): Promise<any> {
  const res = await s.send("POST", "/R4/Observation", body);
  expect(res.status).toBe(201);
  return res.json();
}
const read = async (version: "R4" | "R6", id: string): Promise<any> => {
  const res = await s.send("GET", `/${version}/Observation/${id}`);
  expect(res.status).toBe(200);
  return res.json();
};
const put = (version: "R4" | "R6", body: any, headers: Record<string, string> = {}) =>
  s.send("PUT", `/${version}/Observation/${body.id}`, body, headers);

const sansMeta = ({ meta: _meta, ...rest }: any) => rest;
const errors = (version: "R4" | "R6", resource: any) =>
  (s.validators[version].validate(resource).issue ?? []).filter((i: any) => i.severity === "error" || i.severity === "fatal");
const storedLinks = (r4: any) =>
  (r4.bodySite?.extension ?? []).filter((e: any) => e.url === BODY_SITE).map((e: any) => e.valueReference.reference);

describe("create, read, update and delete through R6", () => {
  test("POST stores the resource and returns it as R6, with the server's id", async () => {
    const res = await s.send("POST", "/R6/Observation", { ...base, id: "ignored", valueQuantity: { value: 33.2, unit: "Cel" } });
    expect(res.status).toBe(201);
    const created: any = await res.json();
    expect(created.id).not.toBe("ignored");
    expect(created.meta.versionId).toBe("1");
    expect(res.headers.get("etag")).toBe('W/"1"');
    expect(res.headers.get("location")).toEndWith(`/R6/Observation/${created.id}/_history/1`);
    expect(sansMeta(await read("R6", created.id))).toEqual({ ...base, id: created.id, valueQuantity: { value: 33.2, unit: "Cel" } });
  });

  test("PUT updates, and PUT to a new id creates", async () => {
    const created = await createR6(base);
    const updated = await put("R6", { ...base, id: created.id, status: "amended" });
    expect(updated.status).toBe(200);
    expect((await read("R6", created.id)).status).toBe("amended");
    expect((await read("R6", created.id)).meta.versionId).toBe("2");

    const id = crypto.randomUUID();
    expect((await put("R6", { ...base, id })).status).toBe(201);
    expect((await read("R6", id)).meta.versionId).toBe("1");
  });

  test("DELETE returns 204, and the resource returns 410 in both versions", async () => {
    const { id } = await createR6(base);
    expect((await s.send("DELETE", `/R6/Observation/${id}`)).status).toBe(204);
    expect((await s.send("GET", `/R6/Observation/${id}`)).status).toBe(410);
    expect((await s.send("GET", `/R4/Observation/${id}`)).status).toBe(410);
  });

  test("If-Match is checked, and a malformed header is rejected", async () => {
    const { id } = await createR6(base);
    expect((await put("R6", { ...base, id }, { "if-match": 'W/"99"' })).status).toBe(412);
    expect((await put("R6", { ...base, id }, { "if-match": "nonsense" })).status).toBe(400);
    expect((await put("R6", { ...base, id }, { "if-match": 'W/"1"' })).status).toBe(200);
    expect((await read("R6", id)).meta.versionId).toBe("2");
  });

  test("bad requests are rejected", async () => {
    const { id } = await createR6(base);
    const post = (body: unknown) => s.send("POST", "/R6/Observation", body);
    expect((await post({ resourceType: "Patient" })).status).toBe(400);
    expect((await post({ ...base, status: undefined })).status).toBe(422);
    expect((await post({ ...base, notAnElement: true })).status).toBe(422);
    const mismatch = await s.send("PUT", `/R6/Observation/${id}`, { ...base, id: "other" });
    expect(mismatch.status).toBe(400);
    expect((await s.send("PUT", "/R6/Observation", base)).status).toBe(405);
    expect((await s.send("POST", `/R6/Observation/${id}`, base)).status).toBe(405);
    expect((await s.send("GET", "/R6/Observation")).status).toBe(405);
  });

  test("an R6 meta keeps its labels and not its version", async () => {
    const tag = [{ system: "http://example.org", code: "t" }];
    const created = await createR6({ ...base, meta: { versionId: "77", tag } });
    expect(created.meta.versionId).toBe("1");
    expect(created.meta.tag).toEqual(tag);
    expect((await read("R4", created.id)).meta.tag).toEqual(tag);
  });
});

describe("the same data through both versions", () => {
  test("an R6 write is valid R4, and an R4 write is valid R6", async () => {
    const fromR6 = await createR6({ ...base, valueString: "a" });
    const asR4 = await read("R4", fromR6.id);
    expect(asR4.valueString).toBe("a");
    expect(errors("R4", asR4)).toEqual([]);

    const fromR4 = await createR4({ ...base, valueString: "b" });
    const asR6 = await read("R6", fromR4.id);
    expect(asR6.valueString).toBe("b");
    expect(errors("R6", asR6)).toEqual([]);
  });

  test("an edit through one version shows in the other, and moves the version", async () => {
    const { id } = await createR6({ ...base, valueString: "a" });
    const r4 = await read("R4", id);
    expect((await put("R4", { ...r4, valueString: "b" })).status).toBe(200);
    const r6 = await read("R6", id);
    expect(r6.valueString).toBe("b");
    expect((await put("R6", { ...r6, valueString: "c" })).status).toBe(200);
    const again = await read("R4", id);
    expect(again.valueString).toBe("c");
    expect(again.meta.versionId).toBe("3");
  });

  test("an ETag from one version goes stale after a write through the other", async () => {
    const { id } = await createR6(base);
    expect((await put("R4", { ...base, id })).status).toBe(200);
    expect((await put("R6", { ...base, id }, { "if-match": 'W/"1"' })).status).toBe(412);
  });

  test("repeated no-op writes through both versions change only the version", async () => {
    const full = {
      ...base,
      statusReason: { text: "why" },
      bodySite: { text: "arm" },
      bodyStructure: [reference("BodyStructure/abc")],
      referenceRange: [{ text: "range", normalValue: { text: "normal" } }],
      component: [{ code: { text: "a" }, valueString: "x" }],
    };
    const { id } = await createR6(full);
    const r6Before = sansMeta(await read("R6", id));
    const r4Before = sansMeta(await read("R4", id));
    for (let i = 0; i < 2; i++) {
      expect((await put("R6", await read("R6", id))).status).toBe(200);
      expect((await put("R4", await read("R4", id))).status).toBe(200);
    }
    expect(sansMeta(await read("R6", id))).toEqual(r6Before);
    expect(sansMeta(await read("R4", id))).toEqual(r4Before);
    expect((await read("R6", id)).meta.versionId).toBe("5");
  });
});

describe("every value type", () => {
  const values: Record<string, unknown> = {
    valueQuantity: { value: 37.5, unit: "Cel", system: "http://unitsofmeasure.org", code: "Cel" },
    valueCodeableConcept: { coding: [{ system: "http://snomed.info/sct", code: "10828004" }], text: "Positive" },
    valueString: "text",
    valueBoolean: true,
    valueInteger: 7,
    valueRange: { low: { value: 1 }, high: { value: 2 } },
    valueRatio: { numerator: { value: 1 }, denominator: { value: 2 } },
    valueTime: "10:00:00",
    valueDateTime: "2026-01-01T10:00:00Z",
    valuePeriod: { start: "2026-01-01" },
  };
  const effective: Record<string, unknown> = {
    effectiveDateTime: "2026-01-01",
    effectivePeriod: { start: "2026-01-01" },
    effectiveTiming: { event: ["2026-01-01"] },
    effectiveInstant: "2026-01-01T10:00:00Z",
  };

  for (const [key, value] of Object.entries(effective)) {
    test(`${key} round trips from R6 and from R4`, async () => {
      expect((await read("R4", (await createR6({ ...base, [key]: value })).id))[key]).toEqual(value);
      expect((await read("R6", (await createR4({ ...base, [key]: value })).id))[key]).toEqual(value);
    });
  }

  for (const [key, value] of Object.entries(values)) {
    test(`${key} round trips from R6 and from R4, in the resource and in a component`, async () => {
      const r6 = await createR6({ ...base, [key]: value });
      expect((await read("R4", r6.id))[key]).toEqual(value);
      expect((await read("R6", r6.id))[key]).toEqual(value);

      const r4 = await createR4({ ...base, [key]: value });
      expect((await read("R6", r4.id))[key]).toEqual(value);

      const component = [{ code: { text: "c" }, [key]: value }];
      const nested = await createR6({ ...base, component });
      expect((await read("R4", nested.id)).component).toEqual(component);
      expect((await read("R6", nested.id)).component).toEqual(component);
      const nestedR4 = await createR4({ ...base, component });
      expect((await read("R6", nestedR4.id)).component).toEqual(component);
    });
  }

  // R4 `period` is milliseconds and R6 has `interval` with a required unit.
  const r4Sampled = { origin: { value: 0 }, period: 10, dimensions: 1, data: "1 2 3" };
  const r6Sampled = { origin: { value: 0 }, interval: 10, intervalUnit: "ms", dimensions: 1, data: "1 2 3" };

  test("valueSampledData converts period and interval in both directions", async () => {
    const r4 = await createR4({ ...base, valueSampledData: r4Sampled });
    expect((await read("R6", r4.id)).valueSampledData).toEqual(r6Sampled);
    const r6 = await createR6({ ...base, valueSampledData: r6Sampled });
    expect((await read("R4", r6.id)).valueSampledData).toEqual(r4Sampled);
    expect((await read("R6", r6.id)).valueSampledData).toEqual(r6Sampled);
  });

  test("a valueSampledData interval that isn't in milliseconds returns 422", async () => {
    const res = await s.send("POST", "/R6/Observation", { ...base, valueSampledData: { ...r6Sampled, intervalUnit: "s" } });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("intervalUnit");
  });
});

describe("elements only R6 has", () => {
  const cases: Record<string, { element: any; stored: (r4: any) => unknown }> = {
    statusReason: {
      element: { statusReason: { text: "why" } },
      stored: (r4) => r4.extension.find((e: any) => e.url === `${XVER}.statusReason`).valueCodeableConcept,
    },
    organizer: {
      element: { organizer: true },
      stored: (r4) => r4.extension.find((e: any) => e.url === `${XVER}.organizer`).valueBoolean,
    },
    triggeredBy: {
      element: { triggeredBy: [{ observation: { reference: "Observation/1" }, type: "reflex", reason: "z" }] },
      stored: (r4) => r4.extension.find((e: any) => e.url === `${XVER}.triggeredBy`).extension.map((e: any) => e.url),
    },
    context: {
      element: { context: [{ reference: { reference: "Encounter/1" } }] },
      stored: (r4) => r4.extension.find((e: any) => e.url === `${XVER}.context`).valueReference,
    },
    supportingDevice: {
      element: { supportingDevice: [{ concept: { text: "ruler" } }] },
      stored: (r4) => r4.extension.find((e: any) => e.url === `${XVER}.supportingDevice`).valueCodeableConcept,
    },
    "referenceRange.normalValue": {
      element: { referenceRange: [{ text: "range", normalValue: { text: "normal" } }] },
      stored: (r4) => r4.referenceRange[0].extension.find((e: any) => e.url === `${XVER}.referenceRange.normalValue`).valueCodeableConcept,
    },
    valueAttachment: {
      element: { valueAttachment: { contentType: "text/plain", title: "t", height: 3 } },
      stored: (r4) => r4.extension.find((e: any) => e.url === `${XVER}.value`).valueAttachment.title,
    },
    "component.valueAttachment": {
      element: { component: [{ code: { text: "c" }, valueAttachment: { contentType: "text/plain", title: "t" } }] },
      stored: (r4) => r4.component[0].extension.find((e: any) => e.url === `${XVER}.component.value`).valueAttachment.title,
    },
  };

  for (const [name, { element, stored }] of Object.entries(cases)) {
    test(`${name} is an R4 extension, and comes back with none left over`, async () => {
      const { id } = await createR6({ ...base, ...element });

      const r4 = await read("R4", id);
      expect(stored(r4)).toBeTruthy();
      expect(errors("R4", r4)).toEqual([]);

      const r6 = await read("R6", id);
      expect(sansMeta(r6)).toEqual({ ...base, id, ...element });
      expect(errors("R6", r6)).toEqual([]);
      expect(JSON.stringify(r6)).not.toContain(XVER);
    });
  }

  test("a reference and a concept each go to their own value", async () => {
    const context = [{ reference: { reference: "Encounter/1" } }, { concept: { text: "Visit" } }];
    const { id } = await createR6({ ...base, context });
    expect((await read("R6", id)).context).toEqual(context);
  });
});

describe("an R4 PUT that leaves out our extensions", () => {
  const full = {
    ...base,
    statusReason: { text: "why" },
    bodySite: { text: "arm" },
    bodyStructure: [reference("BodyStructure/abc")],
    referenceRange: [{ text: "range", normalValue: { text: "normal" } }],
    component: [
      { code: { text: "c" }, referenceRange: [{ text: "inner", normalValue: { text: "normal inside" } }] },
      { code: { text: "d" }, valueAttachment: { contentType: "text/plain", title: "t" } },
    ],
  };
  const plainR4 = (id: string) => ({
    ...base,
    id,
    bodySite: { text: "arm" },
    referenceRange: [{ text: "range" }],
    component: [
      { code: { text: "c" }, referenceRange: [{ text: "inner" }] },
      { code: { text: "d" } },
    ],
  });

  test("no arrays: everything comes back", async () => {
    const { id } = await createR6(full);
    expect((await put("R4", plainR4(id))).status).toBe(200);
    expect(sansMeta(await read("R6", id))).toEqual({ ...full, id });
  });

  test("a changed list item doesn't get them back, because it's no longer the same item", async () => {
    const { id } = await createR6(full);
    const body = plainR4(id);
    body.referenceRange[0]!.text = "edited";
    expect((await put("R4", body)).status).toBe(200);
    expect((await read("R6", id)).referenceRange).toEqual([{ text: "edited" }]);
  });

  test("an array is the client's intent: what it leaves out is removed", async () => {
    const { id } = await createR6(full);
    const own = { url: "http://example.org/own", valueString: "mine" };
    const res = await put("R4", { ...plainR4(id), extension: [own], bodySite: { text: "arm", extension: [own] } });
    expect(res.status).toBe(200);
    const r6 = await read("R6", id);
    expect(r6.statusReason).toBeUndefined();
    expect(r6.extension).toEqual([own]);
    expect(r6.bodyStructure).toBeUndefined();
    expect(r6.bodySite).toEqual({ text: "arm", extension: [own] });
    expect(r6.referenceRange).toEqual(full.referenceRange);
  });

  test("X-Replace-Extensions removes them everywhere", async () => {
    const { id } = await createR6(full);
    expect((await put("R4", plainR4(id), { "x-replace-extensions": "true" })).status).toBe(200);
    const r6 = await read("R6", id);
    expect(r6.statusReason).toBeUndefined();
    expect(r6.bodyStructure).toBeUndefined();
    expect(r6.referenceRange).toEqual([{ text: "range" }]);
    expect(r6.component[1].valueAttachment).toBeUndefined();
  });

  test("leaving out bodySite altogether removes it and its references", async () => {
    const { id } = await createR6(full);
    const { bodySite: _bodySite, ...body } = plainR4(id);
    expect((await put("R4", body)).status).toBe(200);
    const r6 = await read("R6", id);
    expect(r6.bodySite).toBeUndefined();
    expect(r6.bodyStructure).toBeUndefined();
  });
});

describe("references written through R6", () => {
  test("bodySite text, coding, another extension and several references survive one write", async () => {
    const other = { url: "http://example.org/other", valueString: "keep" };
    const bodySite = { text: "arm", coding: [{ system: "http://snomed.info/sct", code: "368208006" }], extension: [other] };
    const bodyStructure = [reference("BodyStructure/abc", { display: "A" }), reference("BodyStructure/def")];
    const { id } = await createR6({ ...base, bodySite, bodyStructure });

    const r4 = await read("R4", id);
    expect(r4.bodySite.text).toBe("arm");
    expect(r4.bodySite.coding).toEqual(bodySite.coding);
    expect(r4.bodySite.extension).toContainEqual(other);
    expect(storedLinks(r4)).toEqual(["BodyStructure/abc", "BodyStructure/def"]);
    expect(r4.bodySite.extension).toContainEqual(link("BodyStructure/abc", { display: "A" }));

    const r6 = await read("R6", id);
    expect(r6.bodySite).toEqual(bodySite);
    expect(r6.bodyStructure).toEqual(bodyStructure);
  });

  test("references without a bodySite store only the extension, and read back the same", async () => {
    const bodyStructure = [reference("BodyStructure/abc")];
    const { id } = await createR6({ ...base, bodyStructure });
    expect((await read("R4", id)).bodySite).toEqual({ extension: [link("BodyStructure/abc")] });
    const r6 = await read("R6", id);
    expect(r6.bodySite).toBeUndefined();
    expect(r6.bodyStructure).toEqual(bodyStructure);
  });

  test("the reference can be followed in both versions", async () => {
    const created = await s.send("POST", "/R6/BodyStructure", await fixture("multi"));
    const group = ((await created.json()) as any).id;
    const { id } = await createR6({ ...base, bodyStructure: [reference(`BodyStructure/${group}`)] });

    const r6Target = (await read("R6", id)).bodyStructure[0].reference.reference;
    const whole: any = await (await s.send("GET", `/R6/${r6Target}`)).json();
    expect(whole.includedStructure.map((i: any) => i.structure.text)).toEqual(["Forearm", "Upper arm", "Shoulder"]);

    const r4Target = storedLinks(await read("R4", id))[0];
    const primary: any = await (await s.send("GET", `/R4/${r4Target}`)).json();
    expect(primary.location.text).toBe("Forearm");
    const members = primary.extension.find((e: any) => e.url.endsWith("bodystructure-row-group")).extension.filter((e: any) => e.url === "member");
    expect(members.map((m: any) => m.valueReference.reference)).toEqual([`BodyStructure/${group}--2`, `BodyStructure/${group}--3`]);
  });

  test("an R6 reference to a split BodyStructure is stored as a link to every R4 row", async () => {
    const created = await s.send("POST", "/R6/BodyStructure", await fixture("multi"));
    const group = ((await created.json()) as any).id;
    const bodyStructure = [reference(`BodyStructure/${group}`, { display: "left arm" })];
    const { id } = await createR6({ ...base, bodySite: { text: "Left arm" }, bodyStructure });

    const r4 = await read("R4", id);
    expect(storedLinks(r4)).toEqual([`BodyStructure/${group}`, `BodyStructure/${group}--2`, `BodyStructure/${group}--3`]);
    expect(r4.bodySite.extension.every((e: any) => e.valueReference.display === "left arm")).toBe(true);
    for (const target of storedLinks(r4)) expect((await s.send("GET", `/R4/${target}`)).status).toBe(200);

    const r6 = await read("R6", id);
    expect(r6.bodyStructure).toEqual(bodyStructure);
    expect(r6.bodySite).toEqual({ text: "Left arm" });
    expect((await put("R6", { ...r6, status: "amended" })).status).toBe(200);
    expect(storedLinks(await read("R4", id))).toHaveLength(3);
  });

  test("an R4 link to only the primary row stays one link, through R4 and R6 writes", async () => {
    const created = await s.send("POST", "/R6/BodyStructure", await fixture("multi"));
    const group = ((await created.json()) as any).id;
    const { id } = await createR4({ ...base, bodySite: { extension: [link(`BodyStructure/${group}`)] } });
    expect(storedLinks(await read("R4", id))).toEqual([`BodyStructure/${group}`]);
    expect((await put("R6", await read("R6", id))).status).toBe(200);
    expect(storedLinks(await read("R4", id))).toEqual([`BodyStructure/${group}`]);
    expect((await put("R4", await read("R4", id))).status).toBe(200);
    expect(storedLinks(await read("R4", id))).toEqual([`BodyStructure/${group}`]);
  });

  test("a row reference stored through R4 stays through a no-op R6 PUT", async () => {
    const { id } = await createR4({ ...base, bodySite: { text: "arm", extension: [link("BodyStructure/abc--2")] } });
    const r6 = await read("R6", id);
    expect(r6.bodyStructure).toEqual([reference("BodyStructure/abc")]);
    expect((await put("R6", r6)).status).toBe(200);
    expect(storedLinks(await read("R4", id))).toEqual(["BodyStructure/abc--2"]);
  });

  test("it stays through an unrelated R6 edit, and two rows of one group both stay", async () => {
    const { id } = await createR4({ ...base, bodySite: { extension: [link("BodyStructure/abc--2"), link("BodyStructure/abc--3")] } });
    const r6 = await read("R6", id);
    expect((await put("R6", { ...r6, status: "amended" })).status).toBe(200);
    const r4 = await read("R4", id);
    expect(r4.status).toBe("amended");
    expect(storedLinks(r4)).toEqual(["BodyStructure/abc--2", "BodyStructure/abc--3"]);
  });

  test("an R6 PUT without the group removes its row references, and can add another group", async () => {
    const { id } = await createR4({ ...base, bodySite: { extension: [link("BodyStructure/abc--2"), link("BodyStructure/def")] } });
    const r6 = await read("R6", id);
    expect((await put("R6", { ...r6, bodyStructure: [reference("BodyStructure/def"), reference("BodyStructure/ghi")] })).status).toBe(200);
    expect(storedLinks(await read("R4", id))).toEqual(["BodyStructure/def", "BodyStructure/ghi"]);

    const r6Again = await read("R6", id);
    const { bodyStructure: _b, ...withoutAny } = r6Again;
    expect((await put("R6", withoutAny)).status).toBe(200);
    expect((await read("R4", id)).bodySite).toBeUndefined();
  });

  test("a display edited through R6 applies to the rows, and an R4 write with different displays is accepted", async () => {
    const { id } = await createR4({
      ...base,
      bodySite: { extension: [link("BodyStructure/abc--2", { display: "two" }), link("BodyStructure/abc--3", { display: "three" })] },
    });
    const r6 = await read("R6", id);
    expect(r6.bodyStructure).toEqual([reference("BodyStructure/abc", { display: "two" })]);
    expect((await put("R6", { ...r6, bodyStructure: [reference("BodyStructure/abc", { display: "edited" })] })).status).toBe(200);
    expect((await read("R4", id)).bodySite.extension).toEqual([
      link("BodyStructure/abc--2", { display: "edited" }),
      link("BodyStructure/abc--3", { display: "edited" }),
    ]);
  });

  test("a BodyStructure move still rewrites a reference kept through an R6 PUT", async () => {
    const created = await s.send("POST", "/R6/BodyStructure", await fixture("multi"));
    const group = ((await created.json()) as any).id;
    const { id } = await createR4({ ...base, bodySite: { extension: [link(`BodyStructure/${group}--2`)] } });
    expect((await put("R6", await read("R6", id))).status).toBe(200);
    const target: any = await (await s.send("GET", `/R6/BodyStructure/${group}`)).json();
    target.includedStructure.shift();
    expect((await s.send("PUT", `/R6/BodyStructure/${group}`, target)).status).toBe(200);
    expect(storedLinks(await read("R4", id))).toEqual([`BodyStructure/${group}`]);
  });
});

describe("what can't be stored is rejected, and nothing is stored", () => {
  const count = async () => Number((await sql.unsafe(`SELECT count(*) AS n FROM observation_history`))[0].n);

  const r6Rejected: Record<string, { body: any; names: string }> = {
    "bodyStructure.concept": { body: { bodyStructure: [{ concept: { text: "Left arm" } }] }, names: "bodyStructure" },
    "a concept next to a reference": {
      body: { bodyStructure: [{ concept: { text: "Left arm" }, reference: { reference: "BodyStructure/abc" } }] },
      names: "concept",
    },
    "a row id through R6": { body: { bodyStructure: [reference("BodyStructure/abc--2")] }, names: "bodyStructure" },
    "the bodySite extension through R6": { body: { bodySite: { extension: [link("BodyStructure/abc")] } }, names: "bodySite" },
    "a reserved extension URL": {
      body: { extension: [{ url: `${XVER}.statusReason`, valueCodeableConcept: { text: "x" } }] },
      names: "extension",
    },
    modifierExtension: {
      body: { modifierExtension: [{ url: "http://example.org/m", valueBoolean: true }] },
      names: "modifierExtension",
    },
    implicitRules: { body: { implicitRules: "http://example.org/rules" }, names: "implicitRules" },
    contained: {
      body: { contained: [{ resourceType: "Patient", id: "p" }], subject: { reference: "#p" } },
      names: "contained",
    },
    "an attachment size R4 can't hold": {
      body: { valueAttachment: { contentType: "text/plain", size: "3000000000" } },
      names: "valueAttachment.size",
    },
  };

  for (const [name, { body, names }] of Object.entries(r6Rejected)) {
    test(`${name} returns 422 through R6, naming ${names}`, async () => {
      const before = await count();
      const res = await s.send("POST", "/R6/Observation", { ...base, ...body });
      expect(res.status).toBe(422);
      const outcome: any = await res.json();
      expect(outcome.resourceType).toBe("OperationOutcome");
      expect(JSON.stringify(outcome.issue)).toContain(names);
      expect(await count()).toBe(before);
    });
  }

  test("a reference to another type returns 422 through R6", async () => {
    const res = await s.send("POST", "/R6/Observation", { ...base, bodyStructure: [reference("Patient/1")] });
    expect(res.status).toBe(422);
  });

  test("a rejected R6 PUT leaves the resource as it was", async () => {
    const { id } = await createR6({ ...base, valueString: "a" });
    const res = await put("R6", { ...base, id, valueString: "b", bodyStructure: [{ concept: { text: "x" } }] });
    expect(res.status).toBe(422);
    const r6 = await read("R6", id);
    expect(r6.valueString).toBe("a");
    expect(r6.meta.versionId).toBe("1");
  });

  const r4Rejected: Record<string, any> = {
    modifierExtension: { modifierExtension: [{ url: "http://example.org/m", valueBoolean: true }] },
    implicitRules: { implicitRules: "http://example.org/rules" },
    contained: { contained: [{ resourceType: "Patient", id: "p" }], subject: { reference: "#p" } },
    "an R6-only extension of the wrong type": { extension: [{ url: `${XVER}.statusReason`, valueString: "x" }] },
  };

  for (const [name, body] of Object.entries(r4Rejected)) {
    test(`${name} returns 422 through R4, because R6 couldn't return it`, async () => {
      const before = await count();
      const res = await s.send("POST", "/R4/Observation", { ...base, ...body });
      expect(res.status).toBe(422);
      expect(await count()).toBe(before);
    });
  }
});

test("an extension on a primitive is kept through both versions", async () => {
  const status = { extension: [{ url: "http://example.org/p", valueString: "x" }] };
  const res = await s.send("POST", "/R6/Observation", { ...base, _status: status });
  expect(res.status).toBe(201);
  const created: any = await res.json();
  expect(created._status).toEqual(status);
  const stored: any = await (await s.send("GET", `/R4/Observation/${created.id}`)).json();
  expect(stored._status).toEqual(status);
  await s.send("DELETE", `/R4/Observation/${created.id}`);
});
