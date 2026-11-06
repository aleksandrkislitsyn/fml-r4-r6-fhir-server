/**
 * Detects content that a conversion to the other FHIR version and back would lose. A write
 * is stored only if nothing is lost, so data is never silently dropped.
 */

/** Comparable form: key order never matters, and neither does the order of the lists named in `unordered`. */
function comparable(value: any, unordered: ReadonlySet<string>, key?: string): any {
  if (Array.isArray(value)) {
    const items = value.map((item) => comparable(item, unordered));
    return key && unordered.has(key)
      ? items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, comparable(value[k], unordered, k)]));
  }
  return value;
}

/** The first path where `after` no longer has what `before` had, or undefined if nothing was lost. */
function firstLoss(before: any, after: any, path: string): string | undefined {
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    for (let i = 0; i < before.length; i++) {
      const loss = firstLoss(before[i], after[i], `${path}[${i}]`);
      if (loss) return loss;
    }
    return undefined;
  }
  if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    for (const key of Object.keys(before)) {
      const loss = firstLoss(before[key], after[key], `${path}.${key}`);
      if (loss) return loss;
    }
    return undefined;
  }
  return JSON.stringify(before) === JSON.stringify(after) ? undefined : path;
}

/**
 * The first path, such as `Patient.contact[0].role`, where `after` no longer has what
 * `before` had. `id` and `meta` are ignored, because the server assigns them. Content that
 * `after` adds is not a loss.
 */
export function lostContent(before: any, after: any, unordered: ReadonlySet<string> = new Set(["extension"])): string | undefined {
  const strip = ({ id: _id, meta: _meta, ...rest }: any) => comparable(rest, unordered);
  return firstLoss(strip(before), strip(after), before.resourceType);
}
