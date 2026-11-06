import { parseFMLToDocument, StructureMapEngine, type StructureMapDocument } from "fhir-structuremap-js";
import fhirpath from "fhirpath";
import type { Validator } from "./validator.ts";

/**
 * Thin wrapper over fhir-structuremap-js. The engine has no FHIR type information, which
 * explains the workarounds here and the style our hand-written maps have to follow:
 *
 * - Its parser needs a `map "url" = name` line and bare rule names, while our maps use
 *   `///` metadata and quoted names, so `normalizeFml` rewrites both before parsing.
 * - It only treats a target as repeating if it is already an array, so `create()` returns
 *   instances with their repeating elements pre-seeded from the target version's
 *   StructureDefinition. `stripEmpty` removes the unused ones afterwards.
 * - Maps must copy with `src.a as v -> tgt.a = v` (a bare `src.a -> tgt.a` creates `{}`) and
 *   add to repeating elements with `= create(...)` (a bare target reuses the existing array).
 * - `extends` and default type groups only look inside one map, so the generated maps in
 *   fml-maps/R4_R6 can't run unchanged. Maps here don't depend on imports.
 * - `(expr)` evaluates against the rule's target context; use `evaluate(var, expr)`.
 */
export function normalizeFml(text: string): string {
  const url = text.match(/^\/\/\/\s*url\s*=\s*['"]([^'"]+)/m)?.[1];
  const name = text.match(/^\/\/\/\s*name\s*=\s*['"]([^'"]+)/m)?.[1];
  if (!url || !name) throw new Error("FML map is missing /// url or /// name metadata");
  const body = text.replace(/^\/\/\/.*$/gm, "").replace(/"([A-Za-z_][\w-]*)"(\s*;)/g, "$1$2");
  return `map "${url}" = ${name}\n${body}`;
}

export async function loadMap(path: string): Promise<StructureMapDocument> {
  return parseFMLToDocument(normalizeFml(await Bun.file(path).text()));
}

/** Removes empty arrays left over from seeding; FHIR JSON doesn't allow them. */
export function stripEmpty<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripEmpty) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (Array.isArray(v) && v.length === 0) continue;
      out[k] = stripEmpty(v);
    }
    return out as T;
  }
  return value;
}

/**
 * Runs a map whose first group is `(source, target)`. `targetValidator` is the validator
 * for the version being produced, used to seed repeating elements.
 */
export function runMap(
  doc: StructureMapDocument,
  source: unknown,
  targetType: string,
  targetValidator: Validator,
): any {
  const seed = (type?: string) => {
    const instance: Record<string, unknown[]> = {};
    for (const element of type ? targetValidator.repeatingOf(type) : []) instance[element] = [];
    return instance;
  };
  const engine = new StructureMapEngine({
    evaluator: { evaluate: (resource, expr, env) => fhirpath.evaluate(resource, expr, env as any) as unknown[] },
    createInstance: seed,
  });
  const [sourceInput, targetInput] = doc.defaultGroup.input;
  const result = engine.run(doc, {
    [sourceInput!.name]: structuredClone(source),
    [targetInput!.name]: seed(targetType),
  });
  return stripEmpty(result[targetInput!.name]);
}
