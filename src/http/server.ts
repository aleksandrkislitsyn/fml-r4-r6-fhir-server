import { isStoredResourceType, type StoredResourceType } from "../db/index.ts";
import * as repo from "../db/repository.ts";
import type { Converter } from "../fhir/convert.ts";
import type { FhirVersion, Validator } from "../fhir/validator.ts";
import { createGroupedHandlers } from "./grouped.ts";
import { checkBody, error, json, parseIfMatch, readBody, resourceHeaders } from "./responses.ts";

const ID_RE = /^[A-Za-z0-9\-.]{1,64}$/;

/**
 * What each version serves. Everything is stored as R4, so a type is only available
 * through R6 once it has FML maps in both directions.
 */
const SUPPORTED: Record<FhirVersion, readonly StoredResourceType[]> = {
  R4: ["Patient", "BodyStructure"],
  R6: ["BodyStructure"],
};

/** Types stored as linked rows, which need the group logic in both versions. */
const GROUPED: readonly StoredResourceType[] = ["BodyStructure"];

export interface ServerDeps {
  validators: Partial<Record<FhirVersion, Validator>>;
  /** Needed for R6 and for grouped types. Without it those return 501. */
  converter?: Converter;
}

export function createHandler({ validators, converter }: ServerDeps) {
  const grouped =
    converter && validators.R4 && validators.R6
      ? createGroupedHandlers({ R4: validators.R4, R6: validators.R6 }, converter)
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
    if (!validator) {
      return error(501, `FHIR ${version} is not implemented yet`, "not-supported");
    }

    if (type === "metadata" && req.method === "GET") return json(capabilityStatement(version));

    if (!type || rest.length > 0) return error(404, `Unsupported path ${url.pathname}`, "not-found");
    if (!isStoredResourceType(type) || !SUPPORTED[version].includes(type)) {
      return error(404, `Resource type ${type} is not supported in ${version}`, "not-supported");
    }
    if (id !== undefined && !ID_RE.test(id)) return error(400, `Invalid id: ${id}`);

    try {
      if (GROUPED.includes(type)) {
        if (!grouped) return error(501, `${type} needs both FHIR versions and the FML maps`, "not-supported");
        return await grouped.handle(req, type, id, version, base);
      }
      if (id === undefined) {
        if (req.method === "POST") return await createResource(req, type, base, validator);
        return error(405, `${req.method} not allowed on /${type}`, "not-supported");
      }
      switch (req.method) {
        case "GET":
          return await readResource(type, id, base);
        case "PUT":
          return await updateResource(req, type, id, base, validator);
        case "DELETE":
          await repo.remove(type, id);
          return new Response(null, { status: 204 });
        default:
          return error(405, `${req.method} not allowed on /${type}/${id}`, "not-supported");
      }
    } catch (e) {
      if (e instanceof repo.VersionConflict) return error(412, e.message, "conflict");
      console.error(e);
      return error(500, "Internal server error", "exception");
    }
  };
}

// Plain resources are R4 only and stored exactly as sent.

async function createResource(
  req: Request,
  type: StoredResourceType,
  base: string,
  validator: Validator,
): Promise<Response> {
  const body = await readBody(req);
  if (body instanceof Response) return body;
  const invalid = checkBody(body, type, validator);
  if (invalid) return invalid;
  const { id: _ignored, ...resource } = body; // server assigns the id on create
  const stored = await repo.create(type, resource);
  return json(stored, 201, resourceHeaders(base, stored));
}

async function readResource(
  type: StoredResourceType,
  id: string,
  base: string,
): Promise<Response> {
  const result = await repo.read(type, id);
  if (result.status === "not-found") return error(404, `${type}/${id} not found`, "not-found");
  if (result.status === "deleted") return error(410, `${type}/${id} was deleted`, "deleted");
  const { location: _l, ...headers } = resourceHeaders(base, result.resource);
  return json(result.resource, 200, headers);
}

async function updateResource(
  req: Request,
  type: StoredResourceType,
  id: string,
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
  const { resource, created } = await repo.update(type, id, body, ifMatch);
  return json(resource, created ? 201 : 200, resourceHeaders(base, resource));
}

function capabilityStatement(version: FhirVersion) {
  return {
    resourceType: "CapabilityStatement",
    status: "draft",
    date: new Date().toISOString(),
    kind: "instance",
    fhirVersion: version === "R4" ? "4.0.1" : "6.0.0",
    format: ["json"],
    rest: [
      {
        mode: "server",
        resource: SUPPORTED[version].map((type) => ({
          type,
          versioning: "versioned",
          updateCreate: true,
          interaction: [{ code: "read" }, { code: "create" }, { code: "update" }, { code: "delete" }],
        })),
      },
    ],
  };
}
