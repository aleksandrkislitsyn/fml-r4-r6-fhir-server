import type { StoredResourceType } from "../db/index.ts";
import * as repo from "../db/repository.ts";
import type { StoredResource } from "../db/repository.ts";
import { plainJson, type WriteConverter } from "../fhir/convert.ts";
import { lostContent } from "../fhir/roundtrip.ts";
import { hasErrors, type Validator } from "../fhir/validator.ts";
import { checkBody, error, json, parseIfMatch, readBody, resourceHeaders } from "./responses.ts";

/** Paths of `modifierExtension` anywhere in the resource. */
function modifierExtensions(node: any, path: string): string[] {
  if (Array.isArray(node)) return node.flatMap((item, i) => modifierExtensions(item, `${path}[${i}]`));
  if (!node || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) =>
    key === "modifierExtension" ? [`${path}.${key}`] : modifierExtensions(value, `${path}.${key}`));
}

/**
 * Content the server can't carry safely: `contained` would need a map for every embedded
 * type, and `implicitRules` and `modifierExtension` can change what a resource means.
 * BodyStructure rejects the same.
 */
function unsupported(resource: any): string[] {
  const type = resource.resourceType;
  return [
    ...["contained", "implicitRules"].filter((key) => resource[key] !== undefined).map((key) => `${type}.${key}`),
    ...modifierExtensions(resource, type),
  ];
}

/**
 * Create and update through /R6 for types stored as one R4 resource (Patient, Encounter).
 * A write is stored only if it is valid R6, its R4 form is valid R4, and it survives
 * R6 -> R4 -> R6 unchanged. Anything else returns 422 naming the first path that would be
 * lost, so an R6 client's data is never silently dropped.
 */
export function createR6WriteHandlers(validators: { R4: Validator; R6: Validator }, converter: WriteConverter) {
  const notStorable = (paths: string[]) =>
    error(422, `Not supported across FHIR versions yet: ${paths.join(", ")}`, "not-supported");

  /** The R4 resource to store for an R6 body, or the response that rejects it. */
  async function toStorable(body: any, signal?: AbortSignal): Promise<StoredResource | Response> {
    const paths = unsupported(body);
    if (paths.length > 0) return notStorable(paths);
    // The server sets the id; toR4 keeps only the labels of meta.
    const { id: _id, ...r6 } = body;

    const r4 = await converter.toR4(r6, signal);
    const back = plainJson<StoredResource>(await converter.toR6(r4, signal));
    const lost = lostContent(r6, back);
    if (lost) return notStorable([lost]);

    const r4Problems = validators.R4.validate(r4);
    if (hasErrors(r4Problems)) {
      // The R6 body was valid, so say that these issues are about the R4 form the server stores.
      const why = { severity: "error", code: "not-supported", diagnostics: `Valid R6, but the R4 ${body.resourceType} it would be stored as is not valid R4` };
      return json({ ...r4Problems, issue: [why, ...(r4Problems.issue ?? [])] }, 422);
    }
    const r6Problems = validators.R6.validate(back);
    return hasErrors(r6Problems) ? json(r6Problems, 422) : r4;
  }

  /**
   * An R6 update replaces the stored R4 resource. If that holds content R6 can't show, such
   * as an R4-only element, the update would remove it without the client ever seeing it.
   */
  async function hiddenContent(type: StoredResourceType, id: string, signal?: AbortSignal): Promise<Response | null> {
    const stored = await repo.read(type, id);
    if (stored.status !== "found") return null;
    const r6 = plainJson<StoredResource>(await converter.toR6(stored.resource, signal));
    const lost = lostContent(stored.resource, await converter.toR4(r6, signal));
    return lost
      ? error(409, `${type}/${id} holds R4 content that R6 can't show (${lost}). An R6 update would remove it; update it through /R4.`, "conflict")
      : null;
  }

  async function respond(stored: StoredResource, status: number, base: string, signal?: AbortSignal) {
    const out = plainJson<StoredResource>(await converter.toR6(stored, signal));
    return json(out, status, resourceHeaders(base, out));
  }

  return {
    async create(req: Request, type: StoredResourceType, base: string): Promise<Response> {
      const body = await readBody(req);
      if (body instanceof Response) return body;
      const invalid = checkBody(body, type, validators.R6);
      if (invalid) return invalid;
      const r4 = await toStorable(body, req.signal);
      if (r4 instanceof Response) return r4;
      return respond(await repo.create(type, r4), 201, base, req.signal);
    },

    async update(req: Request, type: StoredResourceType, id: string, base: string): Promise<Response> {
      const ifMatch = parseIfMatch(req.headers.get("if-match"));
      if (ifMatch === "invalid") return error(400, "Malformed If-Match header");
      const body = await readBody(req);
      if (body instanceof Response) return body;
      const invalid = checkBody(body, type, validators.R6);
      if (invalid) return invalid;
      if (body.id !== id) return error(400, `Resource id ${JSON.stringify(body.id)} does not match URL id ${id}`);
      const r4 = await toStorable(body, req.signal);
      if (r4 instanceof Response) return r4;
      const hidden = await hiddenContent(type, id, req.signal);
      if (hidden) return hidden;
      const { resource, created } = await repo.update(type, id, r4, ifMatch);
      return respond(resource, created ? 201 : 200, base, req.signal);
    },
  };
}
