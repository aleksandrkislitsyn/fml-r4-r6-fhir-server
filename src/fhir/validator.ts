import { CanonicalManager } from "@atomic-ehr/fhir-canonical-manager";
import { translate, validate, type FHIRSchema } from "@atomic-ehr/fhirschema";
import type { OperationOutcome } from "../fhir-types/hl7-fhir-r4-core/OperationOutcome.ts";

export type FhirVersion = "R4" | "R6";

// R6 is still a draft, so its version stays pinned.
const PACKAGES: Partial<Record<FhirVersion, string>> = {
  R4: "hl7.fhir.r4.core@4.0.1",
  R6: "hl7.fhir.r6.core@6.0.0-ballot5",
};

export interface Validator {
  validate(resource: unknown): OperationOutcome;
  knowsType(type: string): boolean;
  /** Names of the repeating child elements of a type or path, e.g. "BodyStructure.includedStructure". */
  repeatingOf(path: string): string[];
}

/**
 * Loads the core package for a FHIR version via the canonical manager and
 * translates every base (non-profile) StructureDefinition into a FHIRSchema.
 */
export async function loadValidator(version: FhirVersion): Promise<Validator> {
  const pkg = PACKAGES[version];
  if (!pkg) throw new Error(`No core package configured for ${version}`);
  const manager = CanonicalManager({
    packages: [pkg],
    workingDir: `.fhir/${version.toLowerCase()}`,
  });
  await manager.init();

  const byUrl: Record<string, FHIRSchema> = {};
  const repeating = new Map<string, string[]>();
  const entries = await manager.searchEntries({});
  for (const entry of entries) {
    if (entry.resourceType !== "StructureDefinition") continue;
    const sd = await manager.read(entry);
    if (sd.derivation === "constraint") continue; // profiles/extensions not needed for base validation
    byUrl[sd.url!] = translate(sd as any);
    for (const element of (sd as any).snapshot?.element ?? []) {
      if (element.max !== "*") continue;
      const dot = element.path.lastIndexOf(".");
      const parent = element.path.slice(0, dot);
      repeating.set(parent, [...(repeating.get(parent) ?? []), element.path.slice(dot + 1).replace("[x]", "")]);
    }
  }

  // The validator expects each schema already merged with its base chain
  // (Patient <- DomainResource <- Resource), keyed by type name.
  const flat: Record<string, FHIRSchema> = {};
  const flatten = (url: string): FHIRSchema | undefined => {
    const own = byUrl[url];
    if (!own) return undefined;
    if (flat[own.type]) return flat[own.type];
    const base = own.base ? flatten(own.base) : undefined;
    return (flat[own.type] = base ? mergeSchema(base, own) : own);
  };
  for (const url of Object.keys(byUrl)) flatten(url);
  const schemas = flat;
  const backboneBase = schemas.BackboneElement?.elements ?? {};
  for (const schema of Object.values(schemas)) addBackboneBase(schema, backboneBase);

  return {
    knowsType: (type) => schemas[type]?.kind === "resource",
    repeatingOf: (path) => repeating.get(path) ?? [],
    validate(resource) {
      const type = (resource as any)?.resourceType;
      const schema = typeof type === "string" ? schemas[type] : undefined;
      if (!schema || schema.kind !== "resource") {
        return outcome(`Unknown resourceType: ${JSON.stringify(type)}`);
      }
      return validate(resource as any, schema, schemas).outcome as OperationOutcome;
    },
  };
}

export function outcome(
  text: string,
  code = "invalid",
  severity: "error" | "warning" | "information" | "fatal" = "error",
): OperationOutcome {
  return { resourceType: "OperationOutcome", issue: [{ severity, code, diagnostics: text }] } as OperationOutcome;
}

export function hasErrors(oo: OperationOutcome): boolean {
  return (oo.issue ?? []).some((i) => i.severity === "error" || i.severity === "fatal");
}

/**
 * Backbone elements hold their children inline, so they never get merged with the
 * BackboneElement base. Without this, the legal `id`, `extension` and `modifierExtension`
 * on them are reported as extra fields.
 */
function addBackboneBase(node: any, base: Record<string, unknown>): void {
  for (const element of Object.values<any>(node.elements ?? {})) {
    if (element.type === "BackboneElement" && element.elements) {
      element.elements = { ...base, ...element.elements };
    }
    addBackboneBase(element, base);
  }
}

const UNION_KEYS = new Set(["required", "excluded"]);

/** Overlay a derived schema (or element) on top of its base. */
function mergeSchema(base: any, overlay: any): any {
  if (base === undefined) return overlay;
  if (overlay === undefined) return base;
  const out: any = { ...base, ...overlay };
  for (const key of UNION_KEYS) {
    if (base[key] || overlay[key]) out[key] = [...new Set([...(base[key] ?? []), ...(overlay[key] ?? [])])];
  }
  if (base.elements || overlay.elements) {
    const elements: Record<string, any> = {};
    for (const k of new Set([...Object.keys(base.elements ?? {}), ...Object.keys(overlay.elements ?? {})])) {
      elements[k] = mergeSchema(base.elements?.[k], overlay.elements?.[k]);
    }
    out.elements = elements;
  }
  return out;
}
