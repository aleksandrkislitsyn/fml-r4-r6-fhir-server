import { isStoredResourceType, STORED_RESOURCE_TYPES, type StoredResourceType } from "../db/index.ts";
import * as repo from "../db/repository.ts";
import { ConversionError, fromStorage, toStorage, type GroupConverter, type ResourceConverter, type WriteConverter } from "../fhir/convert.ts";
import { outcome, type FhirVersion, type Validator } from "../fhir/validator.ts";
import { createGroupedHandlers } from "./grouped.ts";
import { createObservationHandlers } from "./observation.ts";
import { checkBody, error, json, parseIfMatch, readBody, resourceHeaders } from "./responses.ts";

const ID_RE = /^[A-Za-z0-9\-.]{1,64}$/;


/** Types stored as linked rows, which need the group logic in both versions. */
const GROUPED: readonly StoredResourceType[] = ["BodyStructure"];

/** Stored as one R4 resource and writable through R6, so writes need both versions. */
const CROSS_VERSION: readonly StoredResourceType[] = ["Observation"];

export interface ServerDeps {
  validators: Partial<Record<FhirVersion, Validator>>;
  /** Reads any type with an R4 -> R6 map. Types writable through R6 also need both validators, or they return 501. */
  converter?: ResourceConverter & Partial<GroupConverter> & Partial<WriteConverter>;
}

export function createHandler({ validators, converter }: ServerDeps) {
  const grouped =
    converter?.toStorage && converter.fromStorage && validators.R4 && validators.R6
      ? createGroupedHandlers({ R4: validators.R4, R6: validators.R6 }, converter as GroupConverter)
      : undefined;
  const observations =
    converter?.toR4 && validators.R4 && validators.R6
      ? createObservationHandlers({ R4: validators.R4, R6: validators.R6 }, converter as WriteConverter)
      : undefined;

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
    if (type === "SearchParameter" && id !== undefined && req.method === "GET" && validator) {
      return await readSearchParameter(validator, id);
    }
    if (!isStoredResourceType(type)) {
      return error(404, `Resource type ${type} is not supported`, "not-supported");
    }
    if (id !== undefined && !ID_RE.test(id)) return error(400, `Invalid id: ${id}`);

    try {
      if (GROUPED.includes(type)) {
        if (!grouped) return error(501, `${type} needs both FHIR versions and the FML maps`, "not-supported");
        return await grouped.handle(req, type, id, version, base);
      }
      const crossVersion = CROSS_VERSION.includes(type);
      const isCreate = req.method === "POST" && id === undefined;
      const isUpdate = req.method === "PUT" && id !== undefined;
      if (crossVersion && (isCreate || isUpdate)) {
        if (!observations) return error(501, `${type} needs both FHIR versions and the FML maps`, "not-supported");
        return await (isCreate ? observations.create(req, version, base) : observations.update(req, id!, version, base));
      }
      if (version === "R6" && req.method !== "GET" && !crossVersion) {
        return json(outcome("R6 is read-only for this type; use /R4 for writes", "not-supported"), 405, { allow: "GET" });
      }
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

/**
 * R6 `class` semantics on R4: the native Coding plus the cross-version extension codings.
 * R4 `class` keeps its standard meaning, so the backport gets its own name. Its definition is
 * fhir/r4/SearchParameter-Encounter-class-r6.json, loaded by the R4 canonical manager and
 * served at /R4/SearchParameter/Encounter-class-r6.
 */
export const ENCOUNTER_CLASS_BACKPORT = "http://example.org/fhir/SearchParameter/Encounter-class-r6";

/** Encounter search parameters per version, mapped to whether cross-version class codings match. */
const ENCOUNTER_SEARCH_PARAMS: Record<FhirVersion, ReadonlyMap<string, boolean>> = {
  R4: new Map([["class", false], ["class-r6", true]]),
  R6: new Map([["class", true]]),
};

/**
 * SearchParameters known to the canonical manager: the core package plus our local package.
 * The manager replaces `id` with its own index key, so the id is taken from the canonical URL,
 * which ends in `/SearchParameter/<id>` for core and local parameters alike.
 */
async function readSearchParameter(validator: Validator, id: string): Promise<Response> {
  if (!ID_RE.test(id)) return error(400, `Invalid id: ${id}`);
  const entries = await validator.definitions.searchEntries({});
  const entry = entries.find((e) => e.resourceType === "SearchParameter" && e.url?.endsWith(`/SearchParameter/${id}`));
  if (!entry) return error(404, `SearchParameter/${id} not found`, "not-found");
  const resource = await validator.definitions.read(entry);
  return json({ ...resource, id });
}

function encounterSearchParams(version: FhirVersion) {
  const syntax = "Single token: code, system|code, |code, or system|. No modifiers, lists, or pagination.";
  const crossVersion = `native class and codings of the ${repo.ENCOUNTER_CLASS_EXTENSION} extension`;
  const classParam = {
    name: "class",
    definition: "http://hl7.org/fhir/SearchParameter/Encounter-class",
    type: "token",
    documentation: `${version === "R4" ? "Native R4 class only" : `Matches ${crossVersion}`}. ${syntax}`,
  };
  if (version === "R6") return [classParam];
  return [classParam, {
    name: "class-r6",
    definition: ENCOUNTER_CLASS_BACKPORT,
    type: "token",
    documentation: `Backport of R6 class; matches ${crossVersion}`
      + ` (Encounter.class | Encounter.extension('${repo.ENCOUNTER_CLASS_EXTENSION}').value).`
      + ` Cannot be combined with class. ${syntax}`,
  }];
}

async function searchEncounters(
  url: URL,
  base: string,
  version: FhirVersion,
  converter?: ResourceConverter,
  signal?: AbortSignal,
): Promise<Response> {
  const supported = ENCOUNTER_SEARCH_PARAMS[version];
  const names = new Set(url.searchParams.keys());
  for (const name of names) {
    if (!supported.has(name)) return error(400, `Unsupported search parameter: ${name}`, "not-supported");
  }
  if (names.size > 1) return error(400, `Combining ${[...names].join(" and ")} is not supported`, "not-supported");
  const [name] = names;
  const token: repo.ClassToken = {};
  if (name !== undefined) {
    const values = url.searchParams.getAll(name);
    if (values.length > 1) return error(400, `Repeated ${name} parameters are not supported`, "not-supported");
    const value = values[0]!;
    if (/[,\\$]/.test(value)) {
      return error(400, "Comma lists and escaped token values are not supported", "not-supported");
    }
    const parts = value.split("|");
    if (!value || parts.length > 2 || (parts.length === 2 && !parts[0] && !parts[1])) {
      return error(400, `Expected ${name}=code, system|code, |code, or system|`);
    }
    if (parts.length === 1) token.code = value;
    else {
      token.system = parts[0]!;
      if (parts[1]) token.code = parts[1];
    }
  }
  const stored = await repo.searchEncounterClass(token, name !== undefined && supported.get(name) === true);
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
          updateCreate: version === "R4" || GROUPED.includes(type) || CROSS_VERSION.includes(type),
          interaction: version === "R6" && !GROUPED.includes(type) && !CROSS_VERSION.includes(type) ? [
            { code: "read" }, ...(type === "Encounter" ? [{ code: "search-type" }] : []),
          ] : [
            { code: "read" }, { code: "create" }, { code: "update" }, { code: "delete" },
            ...(type === "Encounter" && version === "R4" ? [{ code: "search-type" }] : []),
          ],
          ...(type === "Encounter" ? { searchParam: encounterSearchParams(version) } : {}),
        })),
      },
    ],
  };
}
