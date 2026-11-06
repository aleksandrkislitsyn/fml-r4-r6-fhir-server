import type { StoredResourceType } from "../db/index.ts";
import * as repo from "../db/repository.ts";
import type { StoredResource } from "../db/repository.ts";
import {
  MAX_BASE_ID_LENGTH,
  assignRowIds,
  baseId,
  carryForwardExtensions,
  isSecondaryId,
  orderRows,
  unsupportedR4,
  unsupportedR6,
  withRowLinks,
  withSharedFieldsFrom,
} from "../fhir/bodystructure.ts";
import type { Converter } from "../fhir/convert.ts";
import { hasErrors, type FhirVersion, type Validator } from "../fhir/validator.ts";
import { checkBody, error, json, parseIfMatch, readBody, resourceHeaders } from "./responses.ts";

/**
 * Create, read, update and delete for types stored as linked R4 rows. The same data is
 * reachable through both versions, so every write, from either version, is checked to be
 * valid in both before it commits.
 */
export function createGroupedHandlers(validators: { R4: Validator; R6: Validator }, converter: Converter) {
  const notStorable = (paths: string[]) =>
    error(422, `Not supported across FHIR versions yet: ${paths.join(", ")}`, "not-supported");

  /** Rejects rows that aren't valid R4, or that can't be returned as valid R6. */
  function checkRows(rows: StoredResource[]): Response | null {
    for (const row of rows) {
      const oo = validators.R4.validate(row);
      if (hasErrors(oo)) return json(oo, 422);
    }
    const oo = validators.R6.validate(converter.fromStorage(rows));
    return hasErrors(oo) ? json(oo, 422) : null;
  }

  const newIdError = (id: string) =>
    isSecondaryId(id)
      ? error(400, `Ids containing "--" are reserved for rows the server creates: ${id}`)
      : id.length > MAX_BASE_ID_LENGTH
        ? error(400, `Id is longer than ${MAX_BASE_ID_LENGTH} characters: ${id}`)
        : null;

  /** 404 or 410 for a row or group that has no current content. */
  async function missing(type: StoredResourceType, id: string): Promise<Response> {
    const result = await repo.read(type, id);
    return result.status === "deleted"
      ? error(410, `${type}/${id} was deleted`, "deleted")
      : error(404, `${type}/${id} not found`, "not-found");
  }

  const ifMatchOf = (req: Request) => parseIfMatch(req.headers.get("if-match"));

  /* R6: one resource, stored as one row per includedStructure. */

  async function saveR6(type: StoredResourceType, id: string, body: any, ifMatch: number | undefined) {
    const existing = orderRows(await repo.readGroup(type, id));
    const existingStructures = existing.length > 0 ? (converter.fromStorage(existing) as any).includedStructure : [];
    const rowIds = assignRowIds(id, existingStructures, body.includedStructure, await repo.maxGroupSuffix(type, id));
    const rows = converter.toStorage(body, rowIds);
    const invalid = checkRows(rows);
    if (invalid) return invalid;
    const stored = await repo.writeGroup(type, id, rows, ifMatch === undefined ? undefined : { id, version: ifMatch });
    return converter.fromStorage(stored);
  }

  async function createR6(req: Request, type: StoredResourceType, base: string) {
    const body = await readBody(req);
    if (body instanceof Response) return body;
    const invalid = checkBody(body, type, validators.R6);
    if (invalid) return invalid;
    const paths = unsupportedR6(body);
    if (paths.length > 0) return notStorable(paths);
    const out = await saveR6(type, crypto.randomUUID(), body, undefined);
    return out instanceof Response ? out : json(out, 201, resourceHeaders(base, out));
  }

  async function readR6(type: StoredResourceType, id: string, base: string) {
    if (isSecondaryId(id)) return error(404, `${type}/${id} not found`, "not-found");
    const rows = await repo.readGroup(type, id);
    if (rows[0]?.id !== id) return missing(type, id);
    const out = converter.fromStorage(orderRows(rows));
    const { location: _l, ...headers } = resourceHeaders(base, out);
    return json(out, 200, headers);
  }

  async function updateR6(req: Request, type: StoredResourceType, id: string, base: string) {
    const ifMatch = ifMatchOf(req);
    if (ifMatch === "invalid") return error(400, "Malformed If-Match header");
    const body = await readBody(req);
    if (body instanceof Response) return body;
    const invalid = checkBody(body, type, validators.R6);
    if (invalid) return invalid;
    if (body.id !== id) return error(400, `Resource id ${JSON.stringify(body.id)} does not match URL id ${id}`);
    const idProblem = newIdError(id);
    if (idProblem) return idProblem;
    const paths = unsupportedR6(body);
    if (paths.length > 0) return notStorable(paths);
    const existed = (await repo.readGroup(type, id)).length > 0;
    const out = await saveR6(type, id, body, ifMatch);
    return out instanceof Response ? out : json(out, existed ? 200 : 201, resourceHeaders(base, out));
  }

  /* R4: each row is an ordinary R4 resource, but belongs to a group. */

  async function createR4(req: Request, type: StoredResourceType, base: string) {
    const body = await readBody(req);
    if (body instanceof Response) return body;
    const invalid = checkBody(body, type, validators.R4);
    if (invalid) return invalid;
    const paths = unsupportedR4(body);
    if (paths.length > 0) return notStorable(paths);
    const id = crypto.randomUUID();
    const row = { ...body, id };
    const rejected = checkRows([row]);
    if (rejected) return rejected;
    const [stored] = await repo.writeGroup(type, id, [row]);
    return json(stored, 201, resourceHeaders(base, stored!));
  }

  async function readR4(type: StoredResourceType, id: string, base: string) {
    const result = await repo.read(type, id);
    if (result.status !== "found") return missing(type, id);
    const { location: _l, ...headers } = resourceHeaders(base, result.resource);
    return json(result.resource, 200, headers);
  }

  async function updateR4(req: Request, type: StoredResourceType, id: string, base: string) {
    const ifMatch = ifMatchOf(req);
    if (ifMatch === "invalid") return error(400, "Malformed If-Match header");
    const body = await readBody(req);
    if (body instanceof Response) return body;
    const invalid = checkBody(body, type, validators.R4);
    if (invalid) return invalid;
    if (body.id !== id) return error(400, `Resource id ${JSON.stringify(body.id)} does not match URL id ${id}`);

    const group = baseId(id);
    const rows = orderRows(await repo.readGroup(type, group));
    const stored = rows.find((r) => r.id === id);
    if (!stored) {
      const idProblem = newIdError(id);
      if (idProblem) return idProblem;
    }

    const replaceExtensions = req.headers.get("x-replace-extensions")?.toLowerCase() === "true";
    const incoming = stored ? carryForwardExtensions(stored, body, replaceExtensions) : body;
    const paths = unsupportedR4(incoming);
    if (paths.length > 0) return notStorable(paths);

    // One rule for every write: all rows are rewritten, so shared fields stay the same
    // everywhere and the primary row's version, which is the R6 ETag, always moves.
    const next = withRowLinks(
      stored ? rows.map((r) => (r.id === id ? incoming : withSharedFieldsFrom(incoming, r))) : [incoming],
      group,
    );
    const rejected = checkRows(next);
    if (rejected) return rejected;

    const written = await repo.writeGroup(type, group, next, ifMatch === undefined ? undefined : { id, version: ifMatch });
    const out = written.find((r) => r.id === id)!;
    return json(out, stored ? 200 : 201, resourceHeaders(base, out));
  }

  async function removeR4(type: StoredResourceType, id: string) {
    if (!isSecondaryId(id)) {
      await repo.removeGroup(type, id); // the R6 resource shares the primary row's id
      return new Response(null, { status: 204 });
    }
    const group = baseId(id);
    const rows = orderRows(await repo.readGroup(type, group));
    if (rows.some((r) => r.id === id)) {
      await repo.writeGroup(type, group, withRowLinks(rows.filter((r) => r.id !== id), group));
    }
    return new Response(null, { status: 204 });
  }

  return {
    async handle(
      req: Request,
      type: StoredResourceType,
      id: string | undefined,
      version: FhirVersion,
      base: string,
    ): Promise<Response> {
      const r6 = version === "R6";
      if (id === undefined) {
        if (req.method === "POST") return r6 ? createR6(req, type, base) : createR4(req, type, base);
        return error(405, `${req.method} not allowed on /${type}`, "not-supported");
      }
      switch (req.method) {
        case "GET":
          return r6 ? readR6(type, id, base) : readR4(type, id, base);
        case "PUT":
          return r6 ? updateR6(req, type, id, base) : updateR4(req, type, id, base);
        case "DELETE":
          if (r6 && isSecondaryId(id)) return error(404, `${type}/${id} not found`, "not-found");
          return removeR4(type, id);
        default:
          return error(405, `${req.method} not allowed on /${type}/${id}`, "not-supported");
      }
    },
  };
}
