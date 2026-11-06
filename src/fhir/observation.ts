import type { StoredResource } from "../db/repository.ts";
import { BODY_SITE_URL, R4_MAX_UNSIGNED_INT, baseId, carryForwardExtensions, isSecondaryId } from "./bodystructure.ts";

const REFERENCE_PREFIX = "BodyStructure/";

const isBodySiteLink = (e: any) => e.url === BODY_SITE_URL;
const literalReference = (link: any): string | undefined => link.valueReference?.reference;
const isLocal = (reference: string | undefined): reference is string =>
  reference !== undefined && reference.startsWith(REFERENCE_PREFIX);

/** A link with its target left out, to compare what else it says. */
function withoutTarget(link: any) {
  const { reference: _reference, ...valueReference } = link.valueReference ?? {};
  return { ...link, valueReference };
}

/**
 * R6 only has `BodyStructure/abc`, even when R4 stored a link to row `abc--2`. For each group
 * `next` still links to, this brings back the stored links to its rows, so writing a resource
 * through R6 doesn't widen them. A group `next` doesn't mention is gone. If the link was edited,
 * the edit applies to each of its rows.
 */
export function keepRowReferences<T extends StoredResource>(stored: any, next: T): T {
  const site: any = next.bodySite;
  const links: any[] | undefined = site?.extension;
  const storedLinks: any[] = (stored?.bodySite?.extension ?? []).filter(isBodySiteLink);
  if (!links || storedLinks.length === 0) return next;

  const rowsOf = (id: string) =>
    storedLinks.filter((link) => {
      const reference = literalReference(link);
      return isLocal(reference) && baseId(reference.slice(REFERENCE_PREFIX.length)) === id;
    });

  const extension = links.flatMap((link) => {
    const reference = literalReference(link);
    if (!isBodySiteLink(link) || !isLocal(reference)) return [link];
    const id = reference.slice(REFERENCE_PREFIX.length);
    if (isSecondaryId(id)) return [link];
    const rows = rowsOf(id);
    if (!rows.some((row) => isSecondaryId(literalReference(row)!))) return [link];
    if (Bun.deepEquals(withoutTarget(link), withoutTarget(rows[0]))) return rows;
    return rows.map((row) => ({
      ...link,
      valueReference: { ...link.valueReference, reference: literalReference(row) },
    }));
  });
  return { ...next, bodySite: { ...site, extension } };
}

/** An item without its extensions, and those of the reference ranges inside it. */
function withoutExtensions(item: any) {
  const { extension: _extension, ...rest } = item;
  if (rest.referenceRange) rest.referenceRange = rest.referenceRange.map(withoutExtensions);
  return rest;
}

/** Extensions come back on list items that are otherwise unchanged and have no array of their own. */
function restoreItemExtensions(stored: any[] | undefined, items: any[] | undefined) {
  for (const item of items ?? []) {
    const match = (stored ?? []).find((s) => Bun.deepEquals(withoutExtensions(s), withoutExtensions(item)));
    if (!match) continue;
    if (!item.extension && match.extension) item.extension = match.extension;
    restoreItemExtensions(match.referenceRange, item.referenceRange);
  }
}

/**
 * The same rule as BodyStructure: see `carryForwardExtensions`. An R4 client that drops what it
 * doesn't understand keeps R6-only content and bodySite references, on the resource and inside
 * `bodySite`, `referenceRange` and `component`. Leaving out `bodySite` altogether removes it.
 */
export function carryForwardObservationExtensions(stored: any, incoming: any, replaceExtensions = false): any {
  const next = carryForwardExtensions(stored, incoming, replaceExtensions);
  if (replaceExtensions) return next;
  if (next.bodySite && !next.bodySite.extension && stored.bodySite?.extension) {
    next.bodySite.extension = stored.bodySite.extension;
  }
  restoreItemExtensions(stored.referenceRange, next.referenceRange);
  restoreItemExtensions(stored.component, next.component);
  return next;
}

/** Attachment sizes R4 can't hold. The round trip can't catch these, because the number survives it. */
export function oversizedAttachments(resource: any): string[] {
  const tooBig = (attachment: any) => attachment?.size !== undefined && Number(attachment.size) > R4_MAX_UNSIGNED_INT;
  const found: string[] = [];
  if (tooBig(resource.valueAttachment)) found.push("Observation.valueAttachment.size (larger than R4 can hold)");
  for (const component of resource.component ?? []) {
    if (tooBig(component.valueAttachment)) found.push("Observation.component.valueAttachment.size (larger than R4 can hold)");
  }
  return [...new Set(found)];
}
