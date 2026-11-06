import type { StoredResource } from "../db/repository.ts";
import { BODY_SITE_URL, R4_MAX_UNSIGNED_INT, ROW_GROUP_URL, baseId, carryForwardExtensions, isSecondaryId } from "./bodystructure.ts";

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

/** The group a bodySite link points into: `BodyStructure/abc--2` is in group `abc`. */
function groupOf(link: any): string | undefined {
  const reference = literalReference(link);
  return isBodySiteLink(link) && isLocal(reference) ? baseId(reference.slice(REFERENCE_PREFIX.length)) : undefined;
}

/**
 * R6 has one `BodyStructure/abc`; R4 stores it as rows `abc`, `abc--2`, ... For each bodySite
 * link to a group's primary row, this resolves the row and adds a link to each of its member
 * rows, so an R4 client sees every structure the R6 reference meant. Links that don't resolve
 * (no such BodyStructure, another server) stay as they are.
 *
 * Target state: `Observation_6to4.fml` does this itself with `resolve()`, once the engine keeps
 * the type of a resolved resource. Until then it runs after the map.
 */
export async function withAllBodyStructureRows<T extends StoredResource>(
  resource: T,
  resolve: (reference: string) => Promise<unknown | undefined>,
): Promise<T> {
  const site: any = resource.bodySite;
  const links: any[] | undefined = site?.extension;
  if (!links?.some((link) => groupOf(link) !== undefined)) return resource;

  const present = new Set(links.map(literalReference));
  const extension: any[] = [];
  for (const link of links) {
    extension.push(link);
    const reference = literalReference(link);
    if (groupOf(link) === undefined || isSecondaryId(reference!)) continue;
    const row: any = await resolve(reference!);
    const members: string[] = (row?.extension ?? [])
      .filter((e: any) => e.url === ROW_GROUP_URL)
      .flatMap((group: any) => group.extension ?? [])
      .filter((e: any) => e.url === "member")
      .map((e: any) => e.valueReference?.reference)
      .filter((member: unknown): member is string => typeof member === "string" && !present.has(member));
    for (const member of members) {
      present.add(member);
      extension.push({ ...link, valueReference: { ...link.valueReference, reference: member } });
    }
  }
  return { ...resource, bodySite: { ...site, extension } };
}

/**
 * R6 can't say which rows of a BodyStructure a link means, so an R6 write would replace what an
 * R4 client chose. For each group that `next` still links to and `stored` already links to, the
 * stored links to that group come back: one row, some rows, or all of them. A group `next`
 * doesn't mention is gone, and a group only `next` mentions keeps what `next` says. If the link
 * was edited, the edit applies to each stored row.
 */
export function keepRowReferences<T extends StoredResource>(stored: any, next: T): T {
  const site: any = next.bodySite;
  const links: any[] | undefined = site?.extension;
  const storedLinks: any[] = (stored?.bodySite?.extension ?? []).filter(isBodySiteLink);
  if (!links || storedLinks.length === 0) return next;

  const storedByGroup = new Map<string, any[]>();
  for (const link of storedLinks) {
    const group = groupOf(link);
    if (group !== undefined) storedByGroup.set(group, [...(storedByGroup.get(group) ?? []), link]);
  }

  const done = new Set<string>();
  const extension = links.flatMap((link) => {
    const group = groupOf(link);
    const rows = group === undefined ? undefined : storedByGroup.get(group);
    if (!rows) return [link];
    if (done.has(group!)) return [];
    done.add(group!);
    if (Bun.deepEquals(withoutTarget(link), withoutTarget(rows[0]))) return rows;
    return rows.map((row) => ({ ...link, valueReference: { ...link.valueReference, reference: literalReference(row) } }));
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
