import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hasErrors } from "../src/fhir/validator.ts";
import { EXCLUDED_URL, ROW_GROUP_URL } from "../src/fhir/bodystructure.ts";
import { asRequest, canonical, fixture, sansMeta, startServer, type TestServer } from "./helpers.ts";

/** The same data must stay correct when it's used through both /R4 and /R6. */
let s: TestServer;
beforeAll(async () => {
  s = await startServer();
}, 300_000);
afterAll(() => s.stop());

const createR6 = async () => (await (await s.send("POST", "/R6/BodyStructure", await fixture("multi"))).json()) as any;
const getR4 = async (id: string): Promise<any> => {
  const res = await s.send("GET", `/R4/BodyStructure/${id}`);
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(hasErrors(s.validators.R4.validate(body))).toBe(false);
  return body;
};
const getR6 = async (id: string): Promise<any> => {
  const res = await s.send("GET", `/R6/BodyStructure/${id}`);
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(hasErrors(s.validators.R6.validate(body))).toBe(false);
  return body;
};
const putR4 = async (row: any) => {
  const res = await s.send("PUT", `/R4/BodyStructure/${row.id}`, row);
  expect(res.status).toBe(200);
  return (await res.json()) as any;
};
const texts = (r: any) => r.includedStructure.map((i: any) => i.structure.text);
/** What a typical R4 client sends back: no extensions it doesn't recognise. */
function withoutExtensions(row: any) {
  const { extension: _e, ...rest } = row;
  return {
    ...rest,
    locationQualifier: rest.locationQualifier?.map(({ extension: _x, ...q }: any) => q),
  };
}

describe("R6 and R4 on the same data", () => {
  test("1. saved through R6, each structure reads as a valid R4 resource", async () => {
    const { id } = await createR6();
    expect((await getR4(id)).location.text).toBe("Forearm");
    expect((await getR4(`${id}--2`)).location.text).toBe("Upper arm");
    expect((await getR4(`${id}--3`)).location.text).toBe("Shoulder");
  });

  test("2. R4 update of a secondary row changes only that structure in R6", async () => {
    const { id } = await createR6();
    const before = await getR6(id);
    const row = await getR4(`${id}--2`);
    await putR4({ ...row, location: { text: "Elbow" } });

    const after = await getR6(id);
    expect(texts(after)).toEqual(["Forearm", "Elbow", "Shoulder"]);
    expect(after.includedStructure[0]).toEqual(before.includedStructure[0]);
    expect(after.includedStructure[1].morphology).toEqual(before.includedStructure[1].morphology);
    expect(after.includedStructure[2]).toEqual(before.includedStructure[2]);
  });

  test("3. R4 update of the primary row's shared field reaches R6 and the other rows", async () => {
    const { id } = await createR6();
    await putR4({ ...(await getR4(id)), description: "From primary" });
    expect((await getR6(id)).description).toBe("From primary");
    expect((await getR4(`${id}--3`)).description).toBe("From primary");
  });

  test("4. a shared field changed on a secondary row is not ignored", async () => {
    const { id } = await createR6();
    await putR4({ ...(await getR4(`${id}--2`)), description: "From secondary" });
    expect((await getR6(id)).description).toBe("From secondary");
    expect((await getR4(id)).description).toBe("From secondary");
    expect((await getR4(`${id}--3`)).description).toBe("From secondary");
  });

  test("5. an R4 client dropping extensions doesn't lose laterality or extra morphology", async () => {
    const { id } = await createR6();
    const before = await getR6(id);
    await putR4(withoutExtensions(await getR4(id)));

    const after = await getR6(id);
    expect(after.includedStructure[0].laterality).toEqual(before.includedStructure[0].laterality);
    expect(after.includedStructure[0].morphology).toEqual(before.includedStructure[0].morphology);
    expect(after.includedStructure[0].qualifier).toEqual(before.includedStructure[0].qualifier);
  });

  test("6. removing the laterality code through R4 removes laterality in R6", async () => {
    const { id } = await createR6();
    const row = withoutExtensions(await getR4(id));
    await putR4({ ...row, locationQualifier: row.locationQualifier.filter((q: any) => q.text !== "Left") });

    const after = await getR6(id);
    expect(after.includedStructure[0].laterality).toBeUndefined();
    expect(after.includedStructure[0].qualifier.map((q: any) => q.text)).toEqual(["Volar"]);
  });

  test("7. an R6 ETag goes stale after an R4 update of any row", async () => {
    const created = await createR6();
    const read = await s.send("GET", `/R6/BodyStructure/${created.id}`);
    const etag = read.headers.get("etag")!;
    await putR4({ ...(await getR4(`${created.id}--3`)), location: { text: "Neck" } });

    const res = await s.send("PUT", `/R6/BodyStructure/${created.id}`, created, { "if-match": etag });
    expect(res.status).toBe(412);
  });

  test("8. created through R4, extended through R6", async () => {
    const r4 = {
      resourceType: "BodyStructure",
      location: { text: "Spleen" },
      morphology: { text: "Mass" },
      patient: { reference: "Patient/example" },
    };
    const res = await s.send("POST", "/R4/BodyStructure", r4);
    expect(res.status).toBe(201);
    const { id }: any = await res.json();

    const r6 = await getR6(id);
    expect(texts(r6)).toEqual(["Spleen"]);
    r6.includedStructure.push({ structure: { text: "Liver" } });
    expect((await s.send("PUT", `/R6/BodyStructure/${id}`, r6)).status).toBe(200);

    const primary = await getR4(id);
    expect(primary.location.text).toBe("Spleen");
    expect(primary.morphology.text).toBe("Mass");
    expect((await getR4(`${id}--2`)).location.text).toBe("Liver");
  });

  test("9. R4 without location is rejected: valid R4 but not readable as R6", async () => {
    const r4 = { resourceType: "BodyStructure", patient: { reference: "Patient/example" } };
    expect((await s.send("POST", "/R4/BodyStructure", r4)).status).toBe(422);

    const { id } = await createR6();
    const { location: _l, ...row } = await getR4(id);
    expect((await s.send("PUT", `/R4/BodyStructure/${id}`, row)).status).toBe(422);
    expect((await getR4(id)).location.text).toBe("Forearm");
  });

  test("10. R4 delete of a secondary row removes that structure", async () => {
    const { id } = await createR6();
    expect((await s.send("DELETE", `/R4/BodyStructure/${id}--2`)).status).toBe(204);
    expect(texts(await getR6(id))).toEqual(["Forearm", "Shoulder"]);
    expect((await s.send("GET", `/R4/BodyStructure/${id}--2`)).status).toBe(410);
  });

  test("11. R4 delete of the primary row removes the whole group", async () => {
    const { id } = await createR6();
    expect((await s.send("DELETE", `/R4/BodyStructure/${id}`)).status).toBe(204);
    expect((await s.send("GET", `/R6/BodyStructure/${id}`)).status).toBe(410);
    expect((await s.send("GET", `/R4/BodyStructure/${id}`)).status).toBe(410);
    expect((await s.send("GET", `/R4/BodyStructure/${id}--3`)).status).toBe(410);
  });

  test("12. deleting rows one by one never leaves data R6 can't read", async () => {
    const { id } = await createR6();
    await s.send("DELETE", `/R4/BodyStructure/${id}--2`);
    await s.send("DELETE", `/R4/BodyStructure/${id}--3`);
    expect(texts(await getR6(id))).toEqual(["Forearm"]);
    await s.send("DELETE", `/R4/BodyStructure/${id}`);
    expect((await s.send("GET", `/R6/BodyStructure/${id}`)).status).toBe(410);
    expect(await s.rows(id)).toEqual([]);
  });

  test("13. R6 update from three to two structures: the third row is gone in R4", async () => {
    const created = await createR6();
    const fewer = { ...created, includedStructure: created.includedStructure.slice(0, 2) };
    expect((await s.send("PUT", `/R6/BodyStructure/${created.id}`, fewer)).status).toBe(200);
    expect((await s.send("GET", `/R4/BodyStructure/${created.id}--3`)).status).toBe(410);
  });

  test("14. row ids are R4 only, and new ids can't use the reserved separator", async () => {
    const { id } = await createR6();
    expect((await s.send("GET", `/R6/BodyStructure/${id}--2`)).status).toBe(404);

    const r4 = { resourceType: "BodyStructure", location: { text: "X" }, patient: { reference: "Patient/example" } };
    expect((await s.send("PUT", "/R4/BodyStructure/fresh--2", { ...r4, id: "fresh--2" })).status).toBe(400);

    const r6 = await fixture("multi");
    expect((await s.send("PUT", "/R6/BodyStructure/fresh--2", { ...r6, id: "fresh--2" })).status).toBe(400);
  });

  test("15. repeated reads and no-op writes through both versions don't drift", async () => {
    const { id } = await createR6();
    const r6First = sansMeta(await getR6(id));
    const r4First = sansMeta(await getR4(id));
    for (let i = 0; i < 3; i++) {
      await putR4(await getR4(id));
      const r6 = await getR6(id);
      expect((await s.send("PUT", `/R6/BodyStructure/${id}`, r6)).status).toBe(200);
    }
    expect(sansMeta(await getR6(id))).toEqual(r6First);
    expect(sansMeta(await getR4(id))).toEqual(r4First);
    expect((await s.rows(id)).length).toBe(3);
  });
});

describe("row ids stay stable", () => {
  const plainStructures = (r: any) => r.includedStructure.map(({ id: _id, ...structure }: any) => structure);

  test("16. a deleted row number is never reused", async () => {
    const { id } = await createR6();
    await s.send("DELETE", `/R4/BodyStructure/${id}--2`);
    const r6 = await getR6(id);
    r6.includedStructure.push({ structure: { text: "Neck" } });
    expect((await s.send("PUT", `/R6/BodyStructure/${id}`, r6)).status).toBe(200);

    expect((await getR4(`${id}--4`)).location.text).toBe("Neck");
    expect((await s.send("GET", `/R4/BodyStructure/${id}--2`)).status).toBe(410);
    expect(texts(await getR6(id))).toEqual(["Forearm", "Shoulder", "Neck"]);
  });

  test("17. removing a structure leaves the others in their rows", async () => {
    const { id } = await createR6();
    const r6 = await getR6(id);
    r6.includedStructure.splice(1, 1);
    expect((await s.send("PUT", `/R6/BodyStructure/${id}`, r6)).status).toBe(200);
    expect((await getR4(`${id}--3`)).location.text).toBe("Shoulder");
    expect((await s.send("GET", `/R4/BodyStructure/${id}--2`)).status).toBe(410);
  });

  test("18. a client that sends no element ids still keeps unchanged rows", async () => {
    const { id } = await createR6();
    const r6 = await getR6(id);
    const withoutIds = plainStructures(r6);
    withoutIds.splice(1, 1); // remove the second structure
    expect((await s.send("PUT", `/R6/BodyStructure/${id}`, { ...r6, includedStructure: withoutIds })).status).toBe(200);
    expect((await getR4(`${id}--3`)).location.text).toBe("Shoulder");
    expect((await s.send("GET", `/R4/BodyStructure/${id}--2`)).status).toBe(410);
  });

  test("19. reordering keeps row ids and changes the order", async () => {
    const { id } = await createR6();
    const r6 = await getR6(id);
    r6.includedStructure.reverse();
    expect((await s.send("PUT", `/R6/BodyStructure/${id}`, r6)).status).toBe(200);

    expect(texts(await getR6(id))).toEqual(["Shoulder", "Upper arm", "Forearm"]);
    expect((await getR4(id)).location.text).toBe("Forearm");
    expect((await getR4(`${id}--3`)).location.text).toBe("Shoulder");
  });

  test("20. removing the primary row's structure moves the next one in", async () => {
    const { id } = await createR6();
    const r6 = await getR6(id);
    r6.includedStructure.shift();
    expect((await s.send("PUT", `/R6/BodyStructure/${id}`, r6)).status).toBe(200);

    expect((await getR4(id)).location.text).toBe("Upper arm");
    expect((await s.send("GET", `/R4/BodyStructure/${id}--2`)).status).toBe(410);
    expect((await getR4(`${id}--3`)).location.text).toBe("Shoulder");
    const after = await getR6(id);
    expect(after.id).toBe(id);
    expect(texts(after)).toEqual(["Upper arm", "Shoulder"]);
  });
});

describe("rows show they belong together", () => {
  const link = (row: any) => row.extension?.find((e: any) => e.url === ROW_GROUP_URL);
  const part = (ext: any, url: string) => ext.extension.find((e: any) => e.url === url);

  test("21. rows carry their position and primary, and a group of one has neither", async () => {
    const { id } = await createR6();
    const primary = link(await getR4(id));
    expect(part(primary, "position").valuePositiveInt).toBe(1);
    expect(part(primary, "primary")).toBeUndefined();

    const third = link(await getR4(`${id}--3`));
    expect(part(third, "position").valuePositiveInt).toBe(3);
    expect(part(third, "primary").valueReference.reference).toBe(`BodyStructure/${id}`);

    await s.send("DELETE", `/R4/BodyStructure/${id}--2`);
    expect(part(link(await getR4(`${id}--3`)), "position").valuePositiveInt).toBe(2);

    await s.send("DELETE", `/R4/BodyStructure/${id}--3`);
    expect(link(await getR4(id))).toBeUndefined();
  });

  const members = (row: any) =>
    (link(row)?.extension ?? []).filter((e: any) => e.url === "member").map((e: any) => e.valueReference.reference);

  test("the primary row lists the other rows, and stays correct as the group changes", async () => {
    const { id } = await createR6();
    const ref = (n: number) => `BodyStructure/${id}--${n}`;
    expect(members(await getR4(id))).toEqual([ref(2), ref(3)]);
    expect(members(await getR4(`${id}--2`))).toEqual([]);

    // Removing a row through R4
    await s.send("DELETE", `/R4/BodyStructure/${id}--2`);
    expect(members(await getR4(id))).toEqual([ref(3)]);

    // Adding one through R6 uses the new number
    const r6 = await getR6(id);
    r6.includedStructure.push({ structure: { text: "Neck" } });
    await s.send("PUT", `/R6/BodyStructure/${id}`, r6);
    expect(members(await getR4(id))).toEqual([ref(3), ref(4)]);

    // Reordering changes the order of the list
    const reordered = await getR6(id);
    reordered.includedStructure.reverse();
    await s.send("PUT", `/R6/BodyStructure/${id}`, reordered);
    expect(members(await getR4(id))).toEqual([ref(4), ref(3)]);

    // Moving the next structure into the primary row takes it off the list
    const fewer = await getR6(id);
    fewer.includedStructure = fewer.includedStructure.filter((i: any) => i.id !== "1");
    await s.send("PUT", `/R6/BodyStructure/${id}`, fewer);
    expect(members(await getR4(id))).toEqual([ref(3)]);
    for (const member of members(await getR4(id))) {
      expect((await s.send("GET", `/R4/${member}`)).status).toBe(200);
    }

    // A group of one lists nothing
    await s.send("DELETE", `/R4/BodyStructure/${id}--3`);
    expect(link(await getR4(id))).toBeUndefined();
  });

  test("a client can't change the member list on the primary row", async () => {
    const { id } = await createR6();
    const row = await getR4(id);
    link(row).extension.push({ url: "member", valueReference: { reference: "BodyStructure/other" } });
    const saved = await putR4(row);
    expect(members(saved)).toEqual([`BodyStructure/${id}--2`, `BodyStructure/${id}--3`]);
  });

  test("22. a client can't change the link", async () => {
    const { id } = await createR6();
    const row = await getR4(`${id}--2`);
    row.extension = [{ url: ROW_GROUP_URL, extension: [
      { url: "primary", valueReference: { reference: "BodyStructure/other" } },
      { url: "position", valuePositiveInt: 9 },
    ] }];
    const saved = await putR4(row);
    expect(part(link(saved), "primary").valueReference.reference).toBe(`BodyStructure/${id}`);
    expect(part(link(saved), "position").valuePositiveInt).toBe(2);
    expect(texts(await getR6(id))).toEqual(["Forearm", "Upper arm", "Shoulder"]);
  });
});

describe("removing extensions through R4", () => {
  const twoExtras = async () => {
    const input = await fixture("multi");
    input.includedStructure[0].morphology.push({ text: "Third" });
    return (await (await s.send("POST", "/R6/BodyStructure", input)).json()) as any;
  };
  const singleWithExtra = async () => {
    const input = await fixture("multi");
    input.includedStructure = input.includedStructure.slice(0, 1);
    return (await (await s.send("POST", "/R6/BodyStructure", input)).json()) as any;
  };
  const morphologies = (r6: any) => r6.includedStructure[0].morphology.map((m: any) => m.text);

  test("23. leaving one extra out of the array removes it", async () => {
    const { id } = await twoExtras();
    const row = await getR4(id);
    row.extension = row.extension.filter((e: any) => e.valueCodeableConcept?.text !== "Third");
    await putR4(row);
    expect(morphologies(await getR6(id))).toEqual(["Basal cell carcinoma", "Nevus sebaceus"]);
  });

  test("24. the header removes the last extra", async () => {
    const { id } = await singleWithExtra();
    const { extension: _e, ...row } = await getR4(id);
    const res = await s.send("PUT", `/R4/BodyStructure/${id}`, row, { "X-Replace-Extensions": "true" });
    expect(res.status).toBe(200);
    expect(morphologies(await getR6(id))).toEqual(["Basal cell carcinoma"]);
  });

  test("25. without the header, the same request restores it", async () => {
    const { id } = await singleWithExtra();
    const { extension: _e, ...row } = await getR4(id);
    await putR4(row);
    expect(morphologies(await getR6(id))).toEqual(["Basal cell carcinoma", "Nevus sebaceus"]);
  });

  test("the header drops the laterality marker too, leaving the code as a qualifier", async () => {
    const { id } = await singleWithExtra();
    const row = withoutExtensions(await getR4(id));
    await s.send("PUT", `/R4/BodyStructure/${id}`, row, { "X-Replace-Extensions": "true" });
    const after = (await getR6(id)).includedStructure[0];
    expect(after.laterality).toBeUndefined();
    expect(after.qualifier.map((q: any) => q.text)).toEqual(["Volar", "Left"]);
  });
});

describe("every R6 element through R4", () => {
  test("26. dropped extensions and a no-op R4 write lose nothing", async () => {
    const input = await fixture("full");
    const { id }: any = await (await s.send("POST", "/R6/BodyStructure", input)).json();
    const row = await getR4(id);
    const stripped = withoutExtensions(row);
    stripped.image = stripped.image.map(({ extension: _x, ...a }: any) => a);
    await putR4(stripped);

    expect(canonical(asRequest(await getR6(id)))).toEqual(canonical({ ...input, id }));
  });

  test("27. deleting a row doesn't lose what the whole resource says", async () => {
    const input = await fixture("full");
    const { id }: any = await (await s.send("POST", "/R6/BodyStructure", input)).json();
    expect((await s.send("DELETE", `/R4/BodyStructure/${id}--2`)).status).toBe(204);

    const after = await getR6(id);
    expect(canonical(after.excludedStructure)).toEqual(canonical(input.excludedStructure));
    expect(after.includedStructure.length).toBe(1);
  });

  test("excludedStructure edited on any row stays in sync and is never a row", async () => {
    const input = await fixture("full");
    const { id }: any = await (await s.send("POST", "/R6/BodyStructure", input)).json();
    expect((await s.rows(id)).length).toBe(2);

    const row = await getR4(`${id}--2`);
    row.extension = row.extension.filter((e: any) => e.url !== EXCLUDED_URL);
    await putR4(row);
    expect((await getR6(id)).excludedStructure).toBeUndefined();
    expect((await getR4(id)).extension.some((e: any) => e.url === EXCLUDED_URL)).toBe(false);
  });

  test("28. R6-only attachment fields round trip, and a size R4 can't hold is rejected", async () => {
    const input = await fixture("multi");
    input.image = [{ url: "http://x/y", size: "2048", height: 480, width: 640, frames: 2, duration: 1.5, pages: 3 }];
    const { id }: any = await (await s.send("POST", "/R6/BodyStructure", input)).json();
    expect(typeof (await getR4(id)).image[0].size).toBe("number");
    expect((await getR6(id)).image).toEqual(input.image);

    const tooBig = await fixture("multi");
    tooBig.image = [{ url: "http://x/y", size: "5000000000" }];
    const bigId = `big-${crypto.randomUUID().slice(0, 8)}`;
    const res = await s.send("PUT", `/R6/BodyStructure/${bigId}`, { ...tooBig, id: bigId });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("size");
    expect(await s.rows(bigId)).toEqual([]);
  });

  test("R4 attachment language has no R6 place: 422, not silently dropped", async () => {
    const r4 = {
      resourceType: "BodyStructure",
      location: { text: "Spleen" },
      image: [{ url: "http://x/y", language: "en" }],
      patient: { reference: "Patient/example" },
    };
    const res = await s.send("POST", "/R4/BodyStructure", r4);
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("language");
  });
});
