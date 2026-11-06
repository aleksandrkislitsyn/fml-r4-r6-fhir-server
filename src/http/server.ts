import { isStoredResourceType, STORED_RESOURCE_TYPES, type StoredResourceType } from "../db/index.ts";
import * as repo from "../db/repository.ts";
import { ConversionError, fromStorage, toStorage, type ResourceConverter } from "../fhir/convert.ts";
import { hasErrors, outcome, type FhirVersion, type Validator } from "../fhir/validator.ts";
import { stringifyFmlJson } from "@fhirpath-lab/fml-executor";

const FHIR_JSON = "application/fhir+json; charset=utf-8";
const ID_RE = /^[A-Za-z0-9\-.]{1,64}$/;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(stringifyFmlJson(body), {
    status,
    headers: { "content-type": FHIR_JSON, ...headers },
  });
}

function error(status: number, text: string, code = "invalid"): Response {
  return json(outcome(text, code), status);
}

function resourceHeaders(base: string, r: repo.StoredResource): Record<string, string> {
  return {
    etag: `W/"${r.meta.versionId}"`,
    "last-modified": new Date(r.meta.lastUpdated).toUTCString(),
    location: `${base}/${r.resourceType}/${r.id}/_history/${r.meta.versionId}`,
  };
}

/** Parses `W/"3"` or `"3"` into 3. */
function parseIfMatch(header: string | null): number | undefined | "invalid" {
  if (header === null) return undefined;
  const m = header.match(/^(?:W\/)?"(\d+)"$/);
  return m ? Number(m[1]) : "invalid";
}

async function readBody(req: Request): Promise<any | Response> {
  try {
    return await req.json();
  } catch {
    return error(400, "Request body is not valid JSON", "structure");
  }
}

export interface ServerDeps {
  validators: Partial<Record<FhirVersion, Validator>>;
  converter?: ResourceConverter;
}

export function createHandler({ validators, converter }: ServerDeps) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const [versionSeg, type, id, ...rest] = url.pathname.split("/").filter(Boolean);

    if (versionSeg !== "R4" && versionSeg !== "R6") {
      return error(404, `Unknown path ${url.pathname}. Use /R4/ or /R6/`, "not-found");
    }
    const version: FhirVersion = versionSeg;
    const base = `${url.origin}/${version}`;
    const validator = validators[version];
    if (version === "R4" ? !validator : !converter) {
      return error(501, `FHIR ${version} is not implemented yet`, "not-supported");
    }

    if (type === "metadata" && req.method === "GET") return json(capabilityStatement(version));

    if (!type || rest.length > 0) return error(404, `Unsupported path ${url.pathname}`, "not-found");
    if (!isStoredResourceType(type)) {
      return error(404, `Resource type ${type} is not supported`, "not-supported");
    }
    if (id !== undefined && !ID_RE.test(id)) return error(400, `Invalid id: ${id}`);
    if (version === "R6" && req.method !== "GET") {
      return json(outcome("R6 is read-only; use /R4 for writes", "not-supported"), 405, { allow: "GET" });
    }

    try {
      if (id === undefined) {
        if (req.method === "POST" && validator) return await createResource(req, type, version, base, validator);
        if (req.method === "GET" && type === "Encounter") {
          return await searchEncounters(url, base, version, converter, req.signal);
        }
        return error(405, `${req.method} not allowed on /${type}`, "not-supported");
      }
      switch (req.method) {
        case "GET":
          return await readResource(type, id, version, base, converter, req.signal);
        case "PUT":
          if (!validator) return error(501, `FHIR ${version} writes are not configured`, "not-supported");
          return await updateResource(req, type, id, version, base, validator);
        case "DELETE":
          await repo.remove(type, id);
          return new Response(null, { status: 204 });
        default:
          return error(405, `${req.method} not allowed on /${type}/${id}`, "not-supported");
      }
    } catch (e) {
      if (e instanceof repo.VersionConflict) return error(412, e.message, "conflict");
      console.error(e);
      if (e instanceof ConversionError) {
        return json({
          resourceType: "OperationOutcome",
          issue: [
            { severity: "error", code: e.code, diagnostics: e.message },
            ...e.diagnostics.map((diagnostic) => ({
              severity: diagnostic.severity,
              code: e.code,
              diagnostics: `${diagnostic.sourceName ?? "(map)"}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}`,
            })),
          ],
        }, e.status);
      }
      return error(500, "Internal server error", "exception");
    }
  };
}

async function searchEncounters(
  url: URL,
  base: string,
  version: FhirVersion,
  converter?: ResourceConverter,
  signal?: AbortSignal,
): Promise<Response> {
  for (const key of url.searchParams.keys()) {
    if (key !== "class") return error(400, `Unsupported search parameter: ${key}`, "not-supported");
  }
  const values = url.searchParams.getAll("class");
  if (values.length > 1) return error(400, "Repeated class parameters are not supported", "not-supported");
  const token: repo.ClassToken = {};
  if (values.length) {
    const value = values[0]!;
    if (/[,\\$]/.test(value)) {
      return error(400, "Comma lists and escaped token values are not supported", "not-supported");
    }
    const parts = value.split("|");
    if (!value || parts.length > 2 || (parts.length === 2 && !parts[0] && !parts[1])) {
      return error(400, "Expected class=code, system|code, |code, or system|");
    }
    if (parts.length === 1) token.code = value;
    else {
      token.system = parts[0]!;
      if (parts[1]) token.code = parts[1];
    }
  }
  const stored = await repo.searchEncounterClass(token, version === "R6");
  const resources = await Promise.all(stored.map((resource) => fromStorage(version, resource, converter, signal)));
  return json({
    resourceType: "Bundle",
    type: "searchset",
    total: resources.length,
    link: [{ relation: "self", url: url.href }],
    entry: resources.map((resource) => ({
      fullUrl: `${base}/Encounter/${resource.id}`,
      resource,
      search: { mode: "match" },
    })),
  });
}

function checkBody(body: any, type: StoredResourceType, validator: Validator): Response | null {
  if (body?.resourceType !== type) {
    return error(400, `Expected resourceType ${type}, got ${JSON.stringify(body?.resourceType)}`);
  }
  const oo = validator.validate(body);
  return hasErrors(oo) ? json(oo, 422) : null;
}

async function createResource(
  req: Request,
  type: StoredResourceType,
  version: FhirVersion,
  base: string,
  validator: Validator,
): Promise<Response> {
  const body = await readBody(req);
  if (body instanceof Response) return body;
  const invalid = checkBody(body, type, validator);
  if (invalid) return invalid;
  const { id: _ignored, ...resource } = body; // server assigns the id on create
  const stored = await repo.create(type, toStorage(version, resource));
  const out = await fromStorage(version, stored);
  return json(out, 201, resourceHeaders(base, out));
}

async function readResource(
  type: StoredResourceType,
  id: string,
  version: FhirVersion,
  base: string,
  converter?: ResourceConverter,
  signal?: AbortSignal,
): Promise<Response> {
  const result = await repo.read(type, id);
  if (result.status === "not-found") return error(404, `${type}/${id} not found`, "not-found");
  if (result.status === "deleted") return error(410, `${type}/${id} was deleted`, "deleted");
  const out = await fromStorage(version, result.resource, converter, signal);
  const { location: _l, ...headers } = resourceHeaders(base, result.resource);
  return json(out, 200, headers);
}

async function updateResource(
  req: Request,
  type: StoredResourceType,
  id: string,
  version: FhirVersion,
  base: string,
  validator: Validator,
): Promise<Response> {
  const ifMatch = parseIfMatch(req.headers.get("if-match"));
  if (ifMatch === "invalid") return error(400, "Malformed If-Match header");
  const body = await readBody(req);
  if (body instanceof Response) return body;
  const invalid = checkBody(body, type, validator);
  if (invalid) return invalid;
  if (body.id !== id) return error(400, `Resource id ${JSON.stringify(body.id)} does not match URL id ${id}`);
  const { resource, created } = await repo.update(type, id, toStorage(version, body), ifMatch);
  const out = await fromStorage(version, resource);
  return json(out, created ? 201 : 200, resourceHeaders(base, out));
}

function capabilityStatement(version: FhirVersion) {
  return {
    resourceType: "CapabilityStatement",
    status: "draft",
    date: new Date().toISOString(),
    kind: "instance",
    fhirVersion: version === "R4" ? "4.0.1" : "6.0.0-ballot5",
    format: ["json"],
    rest: [
      {
        mode: "server",
        resource: STORED_RESOURCE_TYPES.map((type) => ({
          type,
          versioning: "versioned",
          updateCreate: version === "R4",
          interaction: version === "R6" ? [
            { code: "read" }, ...(type === "Encounter" ? [{ code: "search-type" }] : []),
          ] : [
            { code: "read" }, { code: "create" }, { code: "update" }, { code: "delete" },
            ...(type === "Encounter" && version === "R4" ? [{ code: "search-type" }] : []),
          ],
          ...(type === "Encounter" ? {
            searchParam: [{
              name: "class",
              definition: "http://hl7.org/fhir/SearchParameter/Encounter-class",
              type: "token",
              documentation: `${version === "R4" ? "Native R4 class only" : "Native class and xver/encounter-class extension codings"}. Single token: code, system|code, |code, or system|. No modifiers, lists, or pagination.`,
            }],
          } : {}),
        })),
      },
    ],
  };
}
