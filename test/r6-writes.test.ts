import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hasErrors } from "../src/fhir/validator.ts";
import { sansMeta, startServer, type TestServer } from "./helpers.ts";

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
}, 300_000);
afterAll(() => s.stop());

const CLASS_EXTENSION = "http://hl7.org/fhir/6.0/StructureDefinition/extension-Encounter.class";
const ACT_CODE = "http://terminology.hl7.org/CodeSystem/v3-ActCode";
const SUBJECT_STATUS = "http://terminology.hl7.org/CodeSystem/encounter-subject-status";

const patient = {
  resourceType: "Patient",
  identifier: [{ system: "urn:example:mrn", value: "12345" }],
  active: true,
  name: [{ family: "Doe", given: ["Jane"] }],
  telecom: [{ system: "phone", value: "+49 30 1234" }],
  gender: "female",
  birthDate: "1990-04-01",
  deceasedBoolean: false,
  address: [{ city: "Berlin" }],
  maritalStatus: { text: "married" },
  multipleBirthInteger: 2,
  photo: [{ contentType: "image/png", url: "http://example.org/photo.png", height: 100, width: 50 }],
  contact: [{
    relationship: [{ text: "mother" }],
    name: { family: "Doe" },
    telecom: [{ system: "phone", value: "+49 30 5678" }],
    address: { city: "Bonn" },
    gender: "female",
    organization: { reference: "Organization/o" },
    period: { start: "2020-01-01" },
  }],
  communication: [{ language: { coding: [{ system: "urn:ietf:bcp:47", code: "de" }] }, preferred: true }],
  generalPractitioner: [{ reference: "Practitioner/gp" }],
  managingOrganization: { reference: "Organization/o" },
  link: [{ other: { reference: "Patient/other" }, type: "seealso" }],
};

const encounter = {
  resourceType: "Encounter",
  status: "completed",
  class: [
    { coding: [{ system: ACT_CODE, code: "AMB" }] },
    { coding: [{ system: ACT_CODE, code: "VR" }] },
  ],
  priority: { text: "routine" },
  type: [{ text: "check-up" }],
  serviceType: [{ concept: { text: "Cardiology" } }],
  subject: { reference: "Patient/p" },
  episodeOfCare: [{ reference: "EpisodeOfCare/e" }],
  basedOn: [{ reference: "ServiceRequest/s" }],
  partOf: { reference: "Encounter/parent" },
  serviceProvider: { reference: "Organization/o" },
  participant: [{ type: [{ text: "attender" }], period: { start: "2026-11-06" }, actor: { reference: "Practitioner/x" } }],
  appointment: [{ reference: "Appointment/a" }],
  actualPeriod: { start: "2026-11-06T10:00:00Z", end: "2026-11-06T11:00:00Z" },
  length: { value: 60, unit: "min", system: "http://unitsofmeasure.org", code: "min" },
  diagnosis: [{ condition: [{ reference: { reference: "Condition/c" } }], use: [{ text: "billing" }] }],
  account: [{ reference: "Account/a" }],
  admission: { admitSource: { text: "emergency" }, dischargeDisposition: { text: "home" } },
  location: [{ location: { reference: "Location/l" }, status: "completed", form: { text: "room" }, period: { start: "2026-11-06" } }],
};

const json = async (res: Response) => (await res.json()) as any;
const diagnostics = (oo: any) => oo.issue.map((i: any) => i.diagnostics ?? i.details?.text).join(" | ");

describe("R6 Patient writes", () => {
  test("create, read through both versions, update with If-Match, delete", async () => {
    const created = await s.send("POST", "/R6/Patient", patient);
    expect(created.status).toBe(201);
    expect(created.headers.get("etag")).toBe('W/"1"');
    const body = await json(created);
    expect(created.headers.get("location")).toEndWith(`/R6/Patient/${body.id}/_history/1`);
    expect(sansMeta(body)).toEqual({ ...patient, id: body.id });

    // Stored as one valid R4 Patient; R6-only Attachment fields sit in extensions.
    const r4 = await json(await s.send("GET", `/R4/Patient/${body.id}`));
    expect(hasErrors(s.validators.R4.validate(r4))).toBe(false);
    expect(r4.photo[0].height).toBeUndefined();
    expect(r4.photo[0].extension).toContainEqual({
      url: "http://hl7.org/fhir/6.0/StructureDefinition/extension-Attachment.height", valuePositiveInt: 100,
    });
    expect(await json(await s.send("GET", `/R6/Patient/${body.id}`))).toEqual(body);

    const updated = await s.send("PUT", `/R6/Patient/${body.id}`, { ...body, gender: "other" }, { "if-match": 'W/"1"' });
    expect(updated.status).toBe(200);
    expect(updated.headers.get("etag")).toBe('W/"2"');
    expect((await json(await s.send("GET", `/R4/Patient/${body.id}`))).gender).toBe("other");

    const stale = await s.send("PUT", `/R6/Patient/${body.id}`, { ...body, gender: "male" }, { "if-match": 'W/"1"' });
    expect(stale.status).toBe(412);

    expect((await s.send("DELETE", `/R6/Patient/${body.id}`)).status).toBe(204);
    expect((await s.send("GET", `/R6/Patient/${body.id}`)).status).toBe(410);
    expect((await s.send("GET", `/R4/Patient/${body.id}`)).status).toBe(410);
  });

  test("PUT with a new id creates the resource", async () => {
    const id = `r6-${crypto.randomUUID()}`;
    const res = await s.send("PUT", `/R6/Patient/${id}`, { ...patient, id });
    expect(res.status).toBe(201);
    expect((await json(res)).id).toBe(id);
    await s.send("DELETE", `/R4/Patient/${id}`);
  });

  test("R6-only content is rejected with its path, and nothing is stored", async () => {
    const id = `r6-${crypto.randomUUID()}`;
    const withRole = { ...patient, id, contact: [{ ...patient.contact[0], role: [{ text: "emergency contact" }] }] };
    const res = await s.send("PUT", `/R6/Patient/${id}`, withRole);
    expect(res.status).toBe(422);
    expect(diagnostics(await json(res))).toContain("Patient.contact[0].role");
    expect((await s.send("GET", `/R4/Patient/${id}`)).status).toBe(404);
  });

  test("contained, implicitRules and modifierExtension are rejected", async () => {
    const cases: [object, string][] = [
      [{ contained: [{ resourceType: "Organization", id: "o" }] }, "Patient.contained"],
      [{ implicitRules: "http://example.org/rules" }, "Patient.implicitRules"],
      [{ contact: [{ ...patient.contact[0], modifierExtension: [{ url: "http://example.org/m", valueBoolean: true }] }] }, "Patient.contact[0].modifierExtension"],
    ];
    for (const [change, path] of cases) {
      const res = await s.send("POST", "/R6/Patient", { ...patient, ...change });
      expect(res.status).toBe(422);
      expect(diagnostics(await json(res))).toContain(path);
    }
  });

  test("invalid R6 and a mismatched id are rejected", async () => {
    expect((await s.send("POST", "/R6/Patient", { ...patient, name: "not-a-list" })).status).toBe(422);
    expect((await s.send("PUT", "/R6/Patient/a", { ...patient, id: "b" })).status).toBe(400);
  });
});

describe("R6 Encounter writes", () => {
  test("classes, status and renamed elements map to R4 and back", async () => {
    const created = await s.send("POST", "/R6/Encounter", encounter);
    expect(created.status).toBe(201);
    const body = await json(created);
    expect(sansMeta(body)).toEqual({ ...encounter, id: body.id });

    const r4 = await json(await s.send("GET", `/R4/Encounter/${body.id}`));
    expect(hasErrors(s.validators.R4.validate(r4))).toBe(false);
    expect(r4.status).toBe("finished");
    expect(r4.class).toEqual({ system: ACT_CODE, code: "AMB" });
    expect(r4.extension).toEqual([{ url: CLASS_EXTENSION, valueCodeableConcept: encounter.class[1] }]);
    expect(r4.serviceType).toEqual({ text: "Cardiology" });
    expect(r4.period).toEqual(encounter.actualPeriod);
    expect(r4.participant[0].individual).toEqual({ reference: "Practitioner/x" });
    expect(r4.diagnosis).toEqual([{ condition: { reference: "Condition/c" }, use: { text: "billing" } }]);
    expect(r4.hospitalization).toEqual(encounter.admission);
    expect(r4.location[0].physicalType).toEqual({ text: "room" });

    expect(await json(await s.send("GET", `/R6/Encounter/${body.id}`))).toEqual(body);
    const found = await json(await s.send("GET", `/R4/Encounter?${new URLSearchParams({ "class-r6": `${ACT_CODE}|VR` })}`));
    expect(found.entry.map((e: any) => e.resource.id)).toContain(body.id);
    await s.send("DELETE", `/R6/Encounter/${body.id}`);
  });

  test("status codes follow HL7's ConceptMaps, and arrived and triaged use subjectStatus", async () => {
    const cases: [object, string][] = [
      [{ status: "planned" }, "planned"],
      [{ status: "in-progress" }, "in-progress"],
      [{ status: "on-hold" }, "onleave"],
      [{ status: "completed" }, "finished"],
      [{ status: "cancelled" }, "cancelled"],
      [{ status: "entered-in-error" }, "entered-in-error"],
      [{ status: "unknown" }, "unknown"],
      [{ status: "in-progress", subjectStatus: { coding: [{ system: SUBJECT_STATUS, code: "arrived" }] } }, "arrived"],
      [{ status: "in-progress", subjectStatus: { coding: [{ system: SUBJECT_STATUS, code: "triaged" }] } }, "triaged"],
    ];
    for (const [r6, r4Status] of cases) {
      const input = { resourceType: "Encounter", class: encounter.class.slice(0, 1), ...r6 };
      const res = await s.send("POST", "/R6/Encounter", input);
      expect(res.status).toBe(201);
      const { id } = await json(res);
      expect((await json(await s.send("GET", `/R4/Encounter/${id}`))).status).toBe(r4Status);
      expect(sansMeta(await json(await s.send("GET", `/R6/Encounter/${id}`)))).toEqual({ ...input, id });
      await s.send("DELETE", `/R4/Encounter/${id}`);
    }
  });

  test("R6 statuses without an R4 code are rejected", async () => {
    for (const status of ["discharged", "discontinued"]) {
      const res = await s.send("POST", "/R6/Encounter", { ...encounter, status });
      expect(res.status).toBe(422);
      expect(diagnostics(await json(res))).toContain("Encounter.status");
    }
  });

  test("valid R6 without class can't be stored as R4", async () => {
    const { class: _class, ...withoutClass } = encounter;
    const res = await s.send("POST", "/R6/Encounter", withoutClass);
    expect(res.status).toBe(422);
    const oo = await json(res);
    expect(oo.issue[0].diagnostics).toContain("not valid R4");
    expect(oo.issue.some((i: any) => i.expression?.includes("class"))).toBe(true);
  });

  test("content the read map can't show is rejected with its path", async () => {
    const cases: [object, string][] = [
      [{ reason: [{ value: [{ concept: { text: "chest pain" } }] }] }, "Encounter.reason"],
      [{ class: [{ coding: [{ code: "AMB" }, { code: "IMP" }] }] }, "Encounter.class[0].coding"],
      [{ serviceType: [{ reference: { reference: "HealthcareService/h" } }] }, "Encounter.serviceType"],
      [{ subjectStatus: { coding: [{ system: SUBJECT_STATUS, code: "departed" }] } }, "Encounter.subjectStatus"],
      [{ extension: [{ url: CLASS_EXTENSION, valueCodeableConcept: { text: "x" } }] }, "Encounter.class"],
    ];
    for (const [change, path] of cases) {
      const res = await s.send("POST", "/R6/Encounter", { ...encounter, ...change });
      expect(res.status).toBe(422);
      expect(diagnostics(await json(res))).toContain(path);
    }
  });

  test("an R6 update can't remove content only R4 shows", async () => {
    const created = await json(await s.send("POST", "/R4/Encounter", {
      resourceType: "Encounter", status: "arrived", class: { code: "AMB" }, reasonCode: [{ text: "chest pain" }],
    }));
    const r6 = await json(await s.send("GET", `/R6/Encounter/${created.id}`));
    expect(r6.status).toBe("in-progress");
    expect(r6.subjectStatus).toEqual({ coding: [{ system: SUBJECT_STATUS, code: "arrived" }] });

    const res = await s.send("PUT", `/R6/Encounter/${created.id}`, r6);
    expect(res.status).toBe(409);
    expect(diagnostics(await json(res))).toContain("Encounter.reasonCode");
    const stored = await json(await s.send("GET", `/R4/Encounter/${created.id}`));
    expect(stored.meta.versionId).toBe("1");
    expect(stored.reasonCode).toEqual([{ text: "chest pain" }]);
    await s.send("DELETE", `/R4/Encounter/${created.id}`);
  });
});

test("R6 metadata advertises writes for every type", async () => {
  const metadata = await json(await s.send("GET", "/R6/metadata"));
  const interactions = (type: string) =>
    metadata.rest[0].resource.find((r: any) => r.type === type).interaction.map((i: any) => i.code);
  for (const type of ["Patient", "Encounter", "BodyStructure"]) {
    expect(interactions(type)).toEqual(expect.arrayContaining(["read", "create", "update", "delete"]));
  }
  expect(interactions("Encounter")).toContain("search-type");
});
