// The package ships no types. Only what src/fhir/fml.ts uses is declared.
declare module "fhir-structuremap-js" {
  export interface StructureMapDocument {
    defaultGroup: { input: { name: string; mode: string }[] };
  }
  export function parseFMLToDocument(fml: string): StructureMapDocument;
  export class StructureMapEngine {
    constructor(options: {
      evaluator: { evaluate(resource: unknown, expr: string, env?: unknown): unknown[] };
      createInstance?: (type?: string) => object;
    });
    run(doc: StructureMapDocument, inputs: Record<string, unknown>, groupName?: string): Record<string, unknown>;
  }
}
