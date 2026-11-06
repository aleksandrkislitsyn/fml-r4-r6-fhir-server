import type { StoredResourceType } from "../db/index.ts";
import * as repo from "../db/repository.ts";
import type { StoredResource } from "../db/repository.ts";
import { bodySiteReferenceProblem, lostContent } from "../fhir/bodystructure.ts";
import { plainJson, type WriteConverter } from "../fhir/convert.ts";
import { carryForwardObservationExtensions, keepRowReferences, oversizedAttachments } from "../fhir/observation.ts";
import { hasErrors, type FhirVersion, type Validator } from "../fhir/validator.ts";
import { checkBody, error, json, parseIfMatch, readBody, resourceHeaders } from "./responses.ts";

const TYPE: StoredResourceType = "Observation";

/**
 * Create and update for a type stored as one R4 resource and writable through both versions.
 * The same data is reachable through both, so every write has to be valid in both, and anything
 * that wouldn't survive the conversion returns 422 rather than being lost.
 */
export function createObservationHandlers(validators: { R4: Validator; R6: Validator }, converter: WriteConverter) {
  const notStorable = (paths: string[]) =>
    error(422, `Not supported across FHIR versions yet: ${paths.join(", ")}`, "not-supported");

  /** What the resource would look like through R6, or why it can't be stored. */
  async function asR6(r4: StoredResource, origin: string): Promise<StoredResource | Response> {
    const problem = bodySiteReferenceProblem(r4, origin);
    if (problem) return error(422, problem);
    const invalidR4 = validators.R4.validate(r4);
    if (hasErrors(invalidR4)) return json(invalidR4, 422);
    const r6 = plainJson<StoredResource>(await converter.toR6(r4));
    const invalidR6 = validators.R6.validate(r6);
    return hasErrors(invalidR6) ? json(invalidR6, 422) : r6;
  }

  /** The R4 form of an R6 body, once it is known to survive the conversion. */
  async function fromR6(body: StoredResource, stored: StoredResource | undefined, origin: string) {
    const oversized = oversizedAttachments(body);
    if (oversized.length > 0) return notStorable(oversized);
    const r4 = keepRowReferences(stored, await converter.toR4(body));
    const r6 = await asR6(r4, origin);
    if (r6 instanceof Response) return r6;
    const lost = lostContent(body, r6);
    return lost ? notStorable([lost]) : r4;
  }

  /** An R4 body, once it is known to be readable through R6 and convert back unchanged. */
  async function fromR4(r4: StoredResource, origin: string) {
    const r6 = await asR6(r4, origin);
    if (r6 instanceof Response) return r6;
    const back = keepRowReferences(r4, await converter.toR4(r6));
    const lost = lostContent(r4, back);
    return lost ? notStorable([lost]) : r4;
  }

  const output = async (version: FhirVersion, stored: StoredResource) =>
    version === "R6" ? converter.toR6(stored) : stored;

  async function current(id: string): Promise<StoredResource | undefined> {
    const result = await repo.read(TYPE, id);
    return result.status === "found" ? result.resource : undefined;
  }

  return {
    async create(req: Request, version: FhirVersion, base: string): Promise<Response> {
      const body = await readBody(req);
      if (body instanceof Response) return body;
      const invalid = checkBody(body, TYPE, validators[version]);
      if (invalid) return invalid;
      const { id: _ignored, ...resource } = body; // server assigns the id on create
      const origin = new URL(base).origin;
      const r4 = version === "R6" ? await fromR6(resource, undefined, origin) : await fromR4(resource, origin);
      if (r4 instanceof Response) return r4;
      const stored = await repo.create(TYPE, r4);
      return json(await output(version, stored), 201, resourceHeaders(base, stored));
    },

    async update(req: Request, id: string, version: FhirVersion, base: string): Promise<Response> {
      const ifMatch = parseIfMatch(req.headers.get("if-match"));
      if (ifMatch === "invalid") return error(400, "Malformed If-Match header");
      const body = await readBody(req);
      if (body instanceof Response) return body;
      const invalid = checkBody(body, TYPE, validators[version]);
      if (invalid) return invalid;
      if (body.id !== id) return error(400, `Resource id ${JSON.stringify(body.id)} does not match URL id ${id}`);

      const existing = await current(id);
      const origin = new URL(base).origin;
      let r4: StoredResource | Response;
      if (version === "R6") {
        r4 = await fromR6(body, existing, origin);
      } else {
        const replaceExtensions = req.headers.get("x-replace-extensions")?.toLowerCase() === "true";
        r4 = await fromR4(existing ? carryForwardObservationExtensions(existing, body, replaceExtensions) : body, origin);
      }
      if (r4 instanceof Response) return r4;

      const { resource, created } = await repo.update(TYPE, id, r4, ifMatch);
      return json(await output(version, resource), created ? 201 : 200, resourceHeaders(base, resource));
    },
  };
}
