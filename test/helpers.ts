import { resolve } from "node:path";
import { migrate } from "../src/db/index.ts";
import { readGroup, type StoredResource } from "../src/db/repository.ts";
import { loadConverter } from "../src/fhir/convert.ts";
import { loadValidator, type Validator } from "../src/fhir/validator.ts";
import { createHandler } from "../src/http/server.ts";

export interface TestServer {
  validators: { R4: Validator; R6: Validator };
  send(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  rows(id: string): Promise<StoredResource[]>;
  stop(): void;
}

/** A server with both FHIR versions and the FML maps loaded. */
export async function startServer(): Promise<TestServer> {
  await migrate();
  const [R4, R6] = await Promise.all([loadValidator("R4"), loadValidator("R6")]);
  const validators = { R4, R6 };
  const server = Bun.serve({
    port: 0,
    fetch: createHandler({ validators, converter: await loadConverter(validators) }),
  });
  return {
    validators,
    send: (method, path, body, headers = {}) =>
      fetch(`${server.url}${path.slice(1)}`, {
        method,
        headers: { "content-type": "application/fhir+json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    rows: (id) => readGroup("BodyStructure", id),
    stop: () => server.stop(true),
  };
}

export async function fixture(name: string): Promise<any> {
  return Bun.file(resolve(import.meta.dir, `fixtures/r6/bodystructure-${name}.json`)).json();
}

export function sansMeta<T extends Record<string, unknown>>(resource: T) {
  const { meta: _meta, ...rest } = resource;
  return rest;
}
