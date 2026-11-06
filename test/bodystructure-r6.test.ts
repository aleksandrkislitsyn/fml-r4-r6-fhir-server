import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hasErrors } from "../src/fhir/validator.ts";
import { fixture, sansMeta, startServer, type TestServer } from "./helpers.ts";

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
}, 300_000);
afterAll(() => s.stop());

const structures = (r: any) => r.includedStructure.map((i: any) => i.structure.text);

describe("R6 BodyStructure stored as R4", () => {
  for (const name of ["tumor", "fetus"]) {
    test(`single structure: ${name} is one R4 row and reads back the same`, async () => {
      const { id: _ignored, ...input } = await fixture(name);
      const res = await s.send("POST", "/R6/BodyStructure", input);
      expect(res.status).toBe(201);
      const created: any = await res.json();

      const rows = await s.rows(created.id);
      expect(rows.map((r) => r.id)).toEqual([created.id]);
      expect(hasErrors(s.validators.R4.validate(rows[0]))).toBe(false);

      const read = await s.send("GET", `/R6/BodyStructure/${created.id}`);
      const body: any = await read.json();
      expect(sansMeta(body)).toEqual({ ...input, id: created.id });
      expect(hasErrors(s.validators.R6.validate(body))).toBe(false);
    });
  }

  test("fan-out: three structures are three valid R4 rows and one R6 resource", async () => {
    const input = await fixture("multi");
    const res = await s.send("POST", "/R6/BodyStructure", input);
    expect(res.status).toBe(201);
    const created: any = await res.json();
    const id = created.id;

    const rows = await s.rows(id);
    expect(rows.map((r) => r.id)).toEqual([id, `${id}--2`, `${id}--3`]);
    expect(rows.map((r: any) => r.location.text)).toEqual(["Forearm", "Upper arm", "Shoulder"]);
    for (const row of rows) expect(hasErrors(s.validators.R4.validate(row))).toBe(false);

    expect(sansMeta(created)).toEqual({ ...input, id });
    expect(structures(created)).toEqual(["Forearm", "Upper arm", "Shoulder"]);
  });

  test("laterality and qualifier share locationQualifier in R4 and separate again in R6", async () => {
    const input = await fixture("multi");
    const { id } = (await (await s.send("POST", "/R6/BodyStructure", input)).json()) as any;
    const [row]: any[] = await s.rows(id);

    expect(row.locationQualifier.map((q: any) => q.text)).toEqual(["Volar", "Left"]);
    expect(row.morphology.text).toBe("Basal cell carcinoma");

    const read: any = await (await s.send("GET", `/R6/BodyStructure/${id}`)).json();
    expect(read.includedStructure[0].laterality).toEqual(input.includedStructure[0].laterality);
    expect(read.includedStructure[0].qualifier).toEqual(input.includedStructure[0].qualifier);
    expect(read.includedStructure[0].morphology).toEqual(input.includedStructure[0].morphology);
  });

  test("no patient is valid R6 but not storable as R4: 422 and nothing stored", async () => {
    const { patient: _p, ...input } = await fixture("multi");
    const id = `no-patient-${crypto.randomUUID().slice(0, 8)}`;
    const res = await s.send("PUT", `/R6/BodyStructure/${id}`, { ...input, id });
    expect(res.status).toBe(422);
    expect(await s.rows(id)).toEqual([]);
  });

  test("unsupported element: 422 naming it, nothing stored", async () => {
    const { id: _ignored, ...input } = await fixture("skin-patch");
    const id = `skin-${crypto.randomUUID().slice(0, 8)}`;
    const res = await s.send("PUT", `/R6/BodyStructure/${id}`, { ...input, id });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("bodyLandmarkOrientation");
    expect(await s.rows(id)).toEqual([]);
  });

  test("update with fewer structures removes the surplus row", async () => {
    const input = await fixture("multi");
    const created: any = await (await s.send("POST", "/R6/BodyStructure", input)).json();
    const fewer = { ...created, includedStructure: created.includedStructure.slice(0, 2) };

    const res = await s.send("PUT", `/R6/BodyStructure/${created.id}`, fewer);
    expect(res.status).toBe(200);
    expect(structures(await res.json())).toEqual(["Forearm", "Upper arm"]);
    expect((await s.rows(created.id)).length).toBe(2);
  });

  test("delete removes all rows, then 410", async () => {
    const { id } = (await (await s.send("POST", "/R6/BodyStructure", await fixture("multi"))).json()) as any;
    expect((await s.send("DELETE", `/R6/BodyStructure/${id}`)).status).toBe(204);
    expect(await s.rows(id)).toEqual([]);
    expect((await s.send("GET", `/R6/BodyStructure/${id}`)).status).toBe(410);
  });

  test("types without maps stay unavailable through R6", async () => {
    const res = await s.send("GET", "/R6/Patient/x");
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).toContain("not-supported");
  });
});
