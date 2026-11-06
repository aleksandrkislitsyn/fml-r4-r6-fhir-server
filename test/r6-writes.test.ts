import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fhirListOrder, lostContent } from "../src/fhir/roundtrip.ts";
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
const R6_ELEMENT = "http://hl7.org/fhir/6.0/StructureDefinition/extension-";
const R4_ELEMENT = "http://hl7.org/fhir/4.0/StructureDefinition/extension-";

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

  test("R6-only contact elements are kept in R4 extensions and read back", async () => {
    const id = `r6-${crypto.randomUUID()}`;
    const contact = {
      ...patient.contact[0],
      role: [{ text: "emergency contact" }],
      additionalName: [{ family: "Roe", given: ["Rita", "Anne"] }],
      additionalAddress: [{ city: "Köln", line: ["Ring 1", "2. OG"] }],
    };
    const input = { ...patient, id, contact: [contact] };
    const res = await s.send("PUT", `/R6/Patient/${id}`, input);
    expect(res.status).toBe(201);

    const r4 = await json(await s.send("GET", `/R4/Patient/${id}`));
    expect(hasErrors(s.validators.R4.validate(r4))).toBe(false);
    expect(r4.contact[0].role).toBeUndefined();
    expect(r4.contact[0].extension).toEqual([
      { url: `${R6_ELEMENT}Patient.contact.role`, valueCodeableConcept: contact.role[0] },
      { url: `${R6_ELEMENT}Patient.contact.additionalName`, valueHumanName: contact.additionalName[0] },
      { url: `${R6_ELEMENT}Patient.contact.additionalAddress`, valueAddress: contact.additionalAddress[0] },
    ]);
    expect(sansMeta(await json(await s.send("GET", `/R6/Patient/${id}`)))).toEqual(input);
    await s.send("DELETE", `/R4/Patient/${id}`);
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
      [{ status: "discharged" }, "finished"],
      [{ status: "cancelled" }, "cancelled"],
      [{ status: "entered-in-error" }, "entered-in-error"],
      [{ status: "unknown" }, "unknown"],
      [{ status: "in-progress", subjectStatus: { coding: [{ system: SUBJECT_STATUS, code: "arrived" }] } }, "arrived"],
      [{ status: "in-progress", subjectStatus: { coding: [{ system: SUBJECT_STATUS, code: "triaged" }] } }, "triaged"],
      [{ status: "in-progress", subjectStatus: { coding: [{ system: SUBJECT_STATUS, code: "departed" }] } }, "in-progress"],
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

  test("discharged is stored as finished, with the R6 code in the status extension", async () => {
    const created = await json(await s.send("POST", "/R6/Encounter", { ...encounter, status: "discharged" }));
    const r4 = await json(await s.send("GET", `/R4/Encounter/${created.id}`));
    expect(r4.status).toBe("finished");
    expect(r4._status).toEqual({ extension: [{ url: `${R6_ELEMENT}Encounter.status`, valueCode: "discharged" }] });
    expect((await json(await s.send("GET", `/R6/Encounter/${created.id}`))).status).toBe("discharged");
    await s.send("DELETE", `/R4/Encounter/${created.id}`);
  });

  test("valid R6 without class can't be stored as R4", async () => {
    const { class: _class, ...withoutClass } = encounter;
    const res = await s.send("POST", "/R6/Encounter", withoutClass);
    expect(res.status).toBe(422);
    const oo = await json(res);
    expect(oo.issue[0].diagnostics).toContain("not valid R4");
    expect(oo.issue.some((i: any) => i.expression?.includes("class"))).toBe(true);
  });

  test("R6-only and multi-valued content is kept in R4 extensions and reads back", async () => {
    const input = {
      resourceType: "Encounter",
      status: "in-progress",
      subjectStatus: { coding: [{ system: SUBJECT_STATUS, code: "departed" }] },
      businessStatus: [{ code: { text: "billing" }, type: { text: "admin" }, effectiveDate: "2026-11-06" }],
      class: [
        { coding: [{ system: ACT_CODE, code: "IMP" }, { system: "urn:example:class", code: "inpatient" }], text: "Inpatient" },
        { coding: [{ system: ACT_CODE, code: "VR" }] },
      ],
      serviceType: [{ reference: { reference: "HealthcareService/h" } }, { concept: { text: "Cardiology" } }],
      subject: { reference: "Patient/p" },
      careTeam: [{ reference: "CareTeam/ct" }],
      virtualService: [{ channelType: { code: "zoom" }, addressUrl: "https://zoom.example/x", maxParticipants: 5, sessionKey: "abc" }],
      plannedStartDate: "2026-11-06T09:00:00Z",
      plannedEndDate: "2026-11-06T12:00:00Z",
      reason: [
        { value: [{ concept: { text: "chest pain" } }] },
        { use: [{ text: "chief complaint" }], value: [{ concept: { text: "dizziness" } }, { reference: { reference: "Observation/o" } }] },
      ],
      diagnosis: [
        { condition: [{ reference: { reference: "Condition/c" } }], use: [{ text: "billing" }] },
        { condition: [{ concept: { text: "flu" } }, { reference: { reference: "Condition/c2" } }], use: [{ text: "AD" }, { text: "DD" }] },
      ],
      dietPreference: [{ text: "vegan" }],
      specialArrangement: [{ text: "wheelchair" }],
      specialCourtesy: [{ text: "VIP" }],
    };
    const res = await s.send("POST", "/R6/Encounter", input);
    expect(res.status).toBe(201);
    const { id } = await json(res);

    const r4 = await json(await s.send("GET", `/R4/Encounter/${id}`));
    expect(hasErrors(s.validators.R4.validate(r4))).toBe(false);
    // What R4 has an element for stays native: the first coding, a plain reason, a plain diagnosis.
    expect(r4.class.code).toBe("IMP");
    expect(r4.class.extension).toEqual([{ url: CLASS_EXTENSION, valueCodeableConcept: input.class[0] }]);
    expect(r4.reasonCode).toEqual([{ text: "chest pain" }]);
    expect(r4.diagnosis).toEqual([{ condition: { reference: "Condition/c" }, use: { text: "billing" } }]);
    expect(r4.hospitalization).toEqual({ dietPreference: input.dietPreference, specialArrangement: input.specialArrangement, specialCourtesy: input.specialCourtesy });
    const urls = r4.extension.map((e: any) => e.url.replace(R6_ELEMENT, ""));
    for (const element of ["subjectStatus", "businessStatus", "careTeam", "virtualService", "plannedStartDate", "plannedEndDate", "reason", "diagnosis", "serviceType"]) {
      expect(urls).toContain(`Encounter.${element}`);
    }

    // Lists may come back in another order: FHIR gives their order no meaning.
    const read = await json(await s.send("GET", `/R6/Encounter/${id}`));
    expect(lostContent(input, read, fhirListOrder)).toBeUndefined();
    expect(hasErrors(s.validators.R6.validate(read))).toBe(false);
    await s.send("DELETE", `/R4/Encounter/${id}`);
  });

  test("references to targets R4 doesn't allow there are kept in extensions", async () => {
    const input = {
      resourceType: "Encounter", status: "in-progress", class: [{ coding: [{ code: "AMB" }] }],
      basedOn: [{ reference: "ServiceRequest/s" }, { reference: "CarePlan/cp" }],
      participant: [{ actor: { reference: "Practitioner/x" } }, { actor: { reference: "Patient/p" } }],
      reason: [{ value: [{ reference: { reference: "Observation/o" } }] }, { value: [{ reference: { reference: "DiagnosticReport/d" } }] }],
    };
    const { id } = await json(await s.send("POST", "/R6/Encounter", input));
    const r4 = await json(await s.send("GET", `/R4/Encounter/${id}`));
    expect(r4.basedOn).toEqual([{ reference: "ServiceRequest/s" }]);
    expect(r4.extension).toContainEqual({ url: `${R6_ELEMENT}Encounter.basedOn`, valueReference: { reference: "CarePlan/cp" } });
    expect(r4.participant[1]).toEqual({ extension: [{ url: `${R6_ELEMENT}Encounter.participant.actor`, valueReference: { reference: "Patient/p" } }] });
    expect(r4.reasonReference).toEqual([{ reference: "Observation/o" }]);
    expect(lostContent(input, await json(await s.send("GET", `/R6/Encounter/${id}`)), fhirListOrder)).toBeUndefined();
    await s.send("DELETE", `/R4/Encounter/${id}`);
  });

  test("what R4 still can't hold returns 422 with its path", async () => {
    const cases: [object, string][] = [
      // TODO in Encounter6to4.fml: no R4 mapping, to be handled with implicitRules.
      [{ status: "discontinued" }, "Encounter.status"],
      [{ length: { value: 1, comparator: "~", unit: "h" } }, "Encounter.length.comparator"],
      [{ virtualService: [{ addressExtendedContactDetail: { name: [{ text: "Front desk" }] } }] }, "Encounter.virtualService"],
      [{ extension: [{ url: CLASS_EXTENSION, valueCodeableConcept: { text: "x" } }] }, "Encounter.class"],
    ];
    for (const [change, path] of cases) {
      const res = await s.send("POST", "/R6/Encounter", { ...encounter, ...change });
      expect(res.status).toBe(422);
      expect(diagnostics(await json(res))).toContain(path);
    }
  });

  test("R4-only history reads as R4 extensions and survives an R6 update", async () => {
    const created = await json(await s.send("POST", "/R4/Encounter", {
      resourceType: "Encounter", status: "arrived", class: { code: "AMB" },
      statusHistory: [{ status: "planned", period: { start: "2026-11-05" } }],
      classHistory: [{ class: { code: "EMER" }, period: { start: "2026-11-05", end: "2026-11-06" } }],
      reasonCode: [{ text: "chest pain" }],
      hospitalization: { dietPreference: [{ text: "vegan" }] },
    }));
    const r6 = await json(await s.send("GET", `/R6/Encounter/${created.id}`));
    expect(r6.status).toBe("in-progress");
    expect(r6.subjectStatus).toEqual({ coding: [{ system: SUBJECT_STATUS, code: "arrived" }] });
    expect(r6.reason).toEqual([{ value: [{ concept: { text: "chest pain" } }] }]);
    expect(r6.dietPreference).toEqual([{ text: "vegan" }]);
    expect(r6.admission).toBeUndefined();
    expect(r6.extension.map((e: any) => e.url)).toEqual([`${R4_ELEMENT}Encounter.statusHistory`, `${R4_ELEMENT}Encounter.classHistory`]);

    // No extension array: the client most likely dropped what it didn't understand.
    const { extension: _dropped, ...withoutExtensions } = r6;
    const kept = await s.send("PUT", `/R6/Encounter/${created.id}`, { ...withoutExtensions, status: "completed" });
    expect(kept.status).toBe(200);
    const afterKeep = await json(await s.send("GET", `/R4/Encounter/${created.id}`));
    expect(afterKeep.status).toBe("finished");
    expect(afterKeep.statusHistory).toEqual([{ status: "planned", period: { start: "2026-11-05" } }]);
    expect(afterKeep.classHistory).toHaveLength(1);

    // An extension array is the client's intent: what it leaves out is removed.
    const latest = await json(await s.send("GET", `/R6/Encounter/${created.id}`));
    const removed = await s.send("PUT", `/R6/Encounter/${created.id}`, { ...latest, extension: latest.extension.slice(0, 1) });
    expect(removed.status).toBe(200);
    const afterRemove = await json(await s.send("GET", `/R4/Encounter/${created.id}`));
    expect(afterRemove.statusHistory).toHaveLength(1);
    expect(afterRemove.classHistory).toBeUndefined();
    await s.send("DELETE", `/R4/Encounter/${created.id}`);
  });

  test("an R6 update can't remove content only R4 shows", async () => {
    const created = await json(await s.send("POST", "/R4/Encounter", {
      resourceType: "Encounter", status: "finished", class: { code: "AMB" },
      diagnosis: [{ condition: { reference: "Condition/c" }, rank: 1 }],
    }));
    const r6 = await json(await s.send("GET", `/R6/Encounter/${created.id}`));
    const res = await s.send("PUT", `/R6/Encounter/${created.id}`, r6);
    expect(res.status).toBe(409);
    expect(diagnostics(await json(res))).toContain("Encounter.diagnosis[0].rank");
    const stored = await json(await s.send("GET", `/R4/Encounter/${created.id}`));
    expect(stored.meta.versionId).toBe("1");
    expect(stored.diagnosis[0].rank).toBe(1);
    await s.send("DELETE", `/R4/Encounter/${created.id}`);
  });
});

test("R6 metadata advertises writes for every type", async () => {
  const metadata = await json(await s.send("GET", "/R6/metadata"));
  const interactions = (type: string) =>
    metadata.rest[0].resource.find((r: any) => r.type === type).interaction.map((i: any) => i.code);
  for (const type of ["Patient", "Encounter", "BodyStructure", "Observation"]) {
    expect(interactions(type)).toEqual(expect.arrayContaining(["read", "create", "update", "delete"]));
  }
  expect(interactions("Encounter")).toContain("search-type");
});
