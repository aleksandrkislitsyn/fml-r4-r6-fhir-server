import type { StoredResource } from "../db/repository.ts";
import { hasErrors, outcome, type Validator } from "../fhir/validator.ts";

const FHIR_JSON = "application/fhir+json; charset=utf-8";

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": FHIR_JSON, ...headers },
  });
}

export function error(status: number, text: string, code = "invalid"): Response {
  return json(outcome(text, code), status);
}

export function resourceHeaders(base: string, r: StoredResource): Record<string, string> {
  return {
    etag: `W/"${r.meta.versionId}"`,
    "last-modified": new Date(r.meta.lastUpdated).toUTCString(),
    location: `${base}/${r.resourceType}/${r.id}/_history/${r.meta.versionId}`,
  };
}

/** Parses `W/"3"` or `"3"` into 3. */
export function parseIfMatch(header: string | null): number | undefined | "invalid" {
  if (header === null) return undefined;
  const m = header.match(/^(?:W\/)?"(\d+)"$/);
  return m ? Number(m[1]) : "invalid";
}

export async function readBody(req: Request): Promise<any | Response> {
  try {
    return await req.json();
  } catch {
    return error(400, "Request body is not valid JSON", "structure");
  }
}

export function checkBody(body: any, type: string, validator: Validator): Response | null {
  if (body?.resourceType !== type) {
    return error(400, `Expected resourceType ${type}, got ${JSON.stringify(body?.resourceType)}`);
  }
  const oo = validator.validate(body);
  return hasErrors(oo) ? json(oo, 422) : null;
}
