# fml-r4-r6-fhir-server

A sample FHIR server on Bun and PostgreSQL 18. Every resource is stored as FHIR **R4**. `/R4` reads and writes the stored data directly. `/R6` executes FHIR Mapping Language (FML) maps over the stored R4 content, in both directions: reads map R4 to R6, and writes map R6 to R4. `Patient`, `Encounter`, `Observation` and `BodyStructure` support full CRUD through both versions.

## Status

- [x] R4 `Patient` CRUD: create, read, update (including create-on-update), delete, versioning, `If-Match`
- [x] Validation of R4 resources with `@atomic-ehr/fhirschema`; core packages are loaded by `@atomic-ehr/fhir-canonical-manager`
- [x] One table per resource type, plus a history table
- [x] R4 → R6 FML execution using the TypeScript FHIRPath Lab executor
- [x] `/R6/Patient/:id` reads and `/R6/metadata`
- [x] R4 Encounter CRUD and native `class` token search
- [x] R6 Encounter class search over native R4 class and cross-version extensions
- [x] R4 `class-r6`: the R6 class search backported to R4. See the [mapping diagrams](docs/mappings.html#encounter-class)
- [x] FML conversion for `BodyStructure` in both directions, with one R6 resource stored as several R4 rows. See the [mapping diagrams](docs/mappings.html)
- [x] `/R6/BodyStructure` CRUD on the same data as `/R4/BodyStructure`
- [x] `Observation` CRUD through `/R4` and `/R6` on the same data, with references to a split `BodyStructure`
- [x] `/R6/Patient` and `/R6/Encounter` CRUD, stored only if the write converts back unchanged. See [R6 writes](#r6-writes-for-patient-and-encounter)
- [ ] R6 writes for other types, including `Device`
- [ ] Other search parameters, history interactions, more resource types

## Quick start

```sh
git submodule update --init --recursive
bun install
bun run build:fml    # build the pinned executor and validator; no Lab UI install
cp .env.example .env
bun run db:up        # Postgres 18 on localhost:5437
bun run dev          # http://localhost:8080
bun test             # integration tests (needs the DB running)
```

The first start downloads `hl7.fhir.r4.core` into `.fhir/`, which takes a few seconds.

```sh
curl -X POST localhost:8080/R4/Patient -H 'content-type: application/fhir+json' \
  -d '{"resourceType":"Patient","name":[{"family":"Doe","given":["Jane"]}],"gender":"female"}'
curl localhost:8080/R4/Patient/<id>
curl localhost:8080/R6/Patient/<id>
```

## FML execution

The [FHIRPath Lab](https://github.com/brianpos/fhirpath-lab/tree/cautious-doodle/fml-vscode-extension/fml-executor)
source is pinned as the `vendor/fhirpath-lab` Git submodule. The build script
generates the validator/executor JavaScript and declarations inside the submodule;
the server resolves their public API names through `tsconfig.json`. Only the
engine's build/runtime dependencies are installed, not the Lab application.
Re-run `bun run build:fml` after updating the submodule.

The default map folders are `fml-maps/R4_R6/maps/StructureMaps` and `fml-maps/R6_R4/maps/StructureMaps`. To use maps
elsewhere on disk, set `FML_MAP_DIRS` to one or more folders. Separate folders
with `;` on Windows or `:` on Unix; relative paths resolve from the working
directory. Folders are scanned recursively.

The map catalog loads on the first R6 resource read, not at startup or for R4
requests. It selects the map and entry group from their declared source/target
types and releases, rather than filenames. All catalog maps are supplied to the
executor so wildcard imports can resolve fully. The first preparation can take
several seconds. Source text and prepared programs are cached in memory;
concurrent requests share preparation but execute with independent targets.
Restart the server after changing maps.

R6 reads never write back to the database or create history versions. IDs and
version metadata must survive mapping. Missing resource maps return `501`;
preparation/execution errors return `500` with an `OperationOutcome`, including
engine diagnostics where available. There is no pass-through fallback or partial
success. R6 `POST`, `PUT`, and `DELETE` are described under
[R6 writes](#r6-writes-for-patient-and-encounter) for `Patient` and `Encounter`,
and in [`docs/mappings.html`](docs/mappings.html) for `BodyStructure` and
`Observation`.

The maps remain draft R6-ballot5 maps, not a production conformance guarantee.
Preparation warnings are logged as a diagnostic count. The converted Encounter
fixture is validated against R6 ballot5 in the integration tests; runtime output
validation, history interactions, terminology services, and external reference
resolution are not implemented. Patient, Encounter and Observation have storage and HTTP support.
`bun test` runs the server's `test/` suite; the vendored Lab has its own tests.

### Encounter class search (R4)

```sh
curl -G localhost:8080/R4/Encounter \
  --data-urlencode 'class=http://terminology.hl7.org/CodeSystem/v3-ActCode|AMB'
```

Returns a `Bundle` of type `searchset`. Searches the native R4 `Encounter.class`
Coding only; cross-version class extensions do not match this R4 parameter
(use `class-r6` for that).
Supports one token: `code`, `system|code`, `|code` (no system), or `system|`
(any code in that system). Without parameters, returns all current Encounters.
This initial implementation has no pagination. Repeated parameters, comma lists,
escaped tokens, modifiers, and other search parameters return `400` with an
`OperationOutcome`.

### Encounter class search (R6)

```sh
curl -G localhost:8080/R6/Encounter \
  --data-urlencode 'class=http://terminology.hl7.org/CodeSystem/v3-ActCode|VR'
```

R6 searches the native R4 `class` and every Coding in
`extension.where(url = 'http://hl7.org/fhir/6.0/StructureDefinition/extension-Encounter.class').valueCodeableConcept.coding`.
The extension URL follows the HL7 cross-version pattern
`http://hl7.org/fhir/[version]/StructureDefinition/extension-[element id]`.
The extension carries the classes beyond the native `class`; R6 receives the
native Coding first, then one CodeableConcept per extension.
System and code must match the same Coding. Each Encounter is returned once,
even when both the native field and extensions match.

Search results use the same injected FML converter as individual R6 reads,
including cancellation and diagnostic handling. The response contains R6
Encounters with `class` as an array of CodeableConcepts. The consumed
class extension is omitted from the R6 representation, while
the stored R4 resource remains unchanged.
Token syntax and search limitations are the same as R4.

The generic extension copy in the R4 → R6 maps skips cross-version extensions
(`http://hl7.org/fhir/5.0/StructureDefinition/extension-…` and
`http://hl7.org/fhir/6.0/StructureDefinition/extension-…`). A resource map that
knows such an extension turns it into the R6 element; otherwise it is not
copied into the R6 output. The generated maps (`DomainResource`, `Element`,
`BackboneElement`) carry the `6.0` part of this filter locally; it still needs
to go upstream to the map generator.

### Encounter class backport (R4)

```sh
curl -G localhost:8080/R4/Encounter \
  --data-urlencode 'class-r6=http://terminology.hl7.org/CodeSystem/v3-ActCode|VR'
```

`class-r6` gives R4 clients the R6 `class` semantics. It matches the native
`class` and every Coding of the class extension, the same set that `/R6`
`class` matches, but returns the stored R4 resources. As a FHIRPath expression:

```
Encounter.class | Encounter.extension('http://hl7.org/fhir/6.0/StructureDefinition/extension-Encounter.class').value
```

R4 `class` keeps its standard meaning, so the backport has its own name. It is
defined by an R4 SearchParameter in `fhir/r4/SearchParameter-Encounter-class-r6.json`,
with canonical `http://example.org/fhir/SearchParameter/Encounter-class-r6`
(`example.org` is a placeholder until the project has its own namespace).
`fhir/r4` is a small local FHIR package that the R4 canonical manager loads next
to `hl7.fhir.r4.core`. The CapabilityStatement points `class-r6` at that
canonical, and the server serves it:

```sh
curl localhost:8080/R4/SearchParameter/Encounter-class-r6
```

`GET /R4/SearchParameter/<id>` serves any SearchParameter the canonical manager
knows, core ones included. The search itself is implemented in
`src/db/repository.ts` and matches the definition's `expression`; the server
doesn't evaluate the expression at runtime. `class` and `class-r6` cannot be
combined in one request (`400`). The other limitations are the same as `class`.
[`docs/mappings.html`](docs/mappings.html#encounter-class) explains the
mapping with a diagram, real server output, and the hard cases.

### R6 writes for Patient and Encounter

```sh
curl -X POST localhost:8080/R6/Encounter -H 'content-type: application/fhir+json' \
  -d '{"resourceType":"Encounter","status":"completed","class":[
        {"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-ActCode","code":"AMB"}]},
        {"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-ActCode","code":"VR"}]}]}'
```

`POST`, `PUT` (with `If-Match` and create-on-update) and `DELETE` work through
`/R6` on the same stored R4 resource that `/R4` serves. A write runs the
`R6_R4` map and is stored only if:

- the body is valid R6 and the result is valid R4,
- and the result maps back through `R4_R6` to the same R6 content.

Anything else returns `422` with an `OperationOutcome`. If content would be
lost, it names the first path, such as `Encounter.status`. Nothing is dropped
silently. Lists may come back in another order, except where FHIR gives the
order a meaning (`HumanName.given`, `prefix`, `suffix`, `Address.line`).
`contained`, `implicitRules` and `modifierExtension` are rejected up front, as
for `BodyStructure`. The server sets `id` and `meta`; only `meta.tag` and
`meta.security` are kept from the body.

What R4 has an element for goes there. Data R4 can't represent goes in
cross-version extensions, following the rule in the FHIR spec (versions.html):
`http://hl7.org/fhir/[defining_version]/StructureDefinition/extension-[ElementDefinition.id]`,
with a `_datatype` child when the value's complex type doesn't exist in R4
(`CodeableReference`, `VirtualServiceDetail`). Where HL7 publishes the R5
equivalent (`hl7.fhir.uv.xver-r5.r4`), the extensions have the same structure.
`6.0` isn't a `defining_version` in the spec yet, because R6 is a ballot; the
URLs anticipate the unpublished `hl7.fhir.uv.xver-r6.r4` package, as the rest
of the project's maps do.


- **R6-only content in R4**: `http://hl7.org/fhir/6.0/StructureDefinition/extension-<element>`.
  Patient `contact.role`, `contact.additionalName` and `contact.additionalAddress`;
  Encounter `businessStatus`, `careTeam`, `virtualService`, `plannedStartDate`,
  `plannedEndDate`, and a `subjectStatus` other than `arrived`/`triaged`. Also
  whatever doesn't fit an R4 element: further classes, and the whole first class
  if it has more than one coding (on R4 `class`); `serviceType` entries other
  than a first plain concept; a reason value with both a concept and a reference
  (`reason.value`); and, on each diagnosis, conditions beyond the first
  reference and uses beyond the first (`diagnosis.condition`, `diagnosis.use`).
  A diagnosis whose first condition is only a concept gets the concept's text as
  `display` in the required R4 `condition`, with the whole value in the
  `diagnosis.condition` extension on it (HL7's FAQ on required references).
  R6-only `Attachment` fields in `photo` are kept as for BodyStructure.
- **R4-only content in R6**: `http://hl7.org/fhir/4.0/StructureDefinition/extension-<element>`,
  for `Encounter.statusHistory` and `Encounter.classHistory`. An R6 `PUT` with no
  `extension` array at all keeps them, because the client most likely dropped
  what it didn't understand. With an `extension` array, what it leaves out is
  removed. `Encounter.diagnosis.rank` stays R4-only: an R6 `PUT` of a resource
  that has one returns `409` instead of removing it.
- **Moved or renamed**: `reason` ↔ `reasonCode`/`reasonReference` (one R6 reason
  per value), `dietPreference`, `specialArrangement` and `specialCourtesy` ↔
  `hospitalization.*`, `actualPeriod` ↔ `period`, `admission` ↔ `hospitalization`,
  `participant.actor` ↔ `individual`, `location.form` ↔ `physicalType`. Before
  this, R6 reads lost `reasonCode`, `reasonReference` and the three
  `hospitalization` lists.
- **Encounter status** follows HL7's R4 ↔ R5 ConceptMaps (R5 and R6 share the
  codes): `on-hold` ↔ `onleave`, `completed` ↔ `finished`. `discharged` is
  stored as `finished` with the R6 code in the status extension (`_status`),
  HL7's rule for required bindings. R4 `arrived` and `triaged` read as
  `in-progress` with that `subjectStatus`. Reads changed with this: `finished`,
  `onleave`, `arrived` and `triaged` used to be copied as invalid R6 codes.
- **Not stored yet (`422`)**: values of a required binding that have no R4
  mapping, which are Encounter `status` `discontinued` and `Quantity.comparator`
  `~` and `ad`. TODO: store the R6 code in the cross-version extension, a
  placeholder R4 code, and set `implicitRules`, because without a mapping the R4
  value alone doesn't carry the meaning. Also `422`: an Encounter without
  `class` (R4 requires one), a `reason` with a `use` or several values (R4 has
  neither, and HL7 defines no extension for them), and
  `virtualService.addressExtendedContactDetail`.
- **Reference targets**: R6 allows more targets in some places (`basedOn`,
  `participant.actor`, `reason`). The reference is copied into the R4 element
  even when R4 doesn't allow that target there, because R4 can represent the
  reference and HL7 defines no extension for other targets. Observation does the
  same.

The R4 validator didn't accept the FHIR JSON form for primitive extensions
(`_status`, `_birthDate`). The server now checks those itself and validates the
rest as before, so R4 clients can send them too. Note that the validator checks
neither required bindings nor reference targets. The maps keep codes within
R4's required bindings; reference targets are copied as described above.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | Entry point: migrate, load the R4 validator, inject the converter, start `Bun.serve` |
| `src/http/server.ts` | Routing for `/R4` and `/R6` and the FHIR REST interactions |
| `src/db/index.ts` | Postgres connection (`Bun.SQL`), the list of stored resource types, migrations |
| `src/db/repository.ts` | Version-aware create, read, update and delete over `<type>` and `<type>_history` tables |
| `src/fhir/validator.ts` | Loads the core package and builds FHIRSchemas used for validation |
| `src/fhir/convert.ts` | Injectable converter for both directions, with cached preparation and execution |
| `src/fhir/roundtrip.ts` | Finds content that a conversion to the other version and back would lose |
| `src/http/r6writes.ts` | R6 create and update for types stored as one R4 resource (Patient, Encounter) |
| `src/fhir/maps.ts` | Configured filesystem map catalog and source/target type selection |
| `scripts/build-fml.ts` | Builds the pinned engine without installing the Lab application |
| `vendor/fhirpath-lab/` | Pinned executor/validator source submodule |
| `src/fhir/bodystructure.ts` | Rules that keep a BodyStructure's R4 rows consistent |
| `src/http/grouped.ts` | CRUD through both versions for types stored as linked rows |
| `src/fhir/observation.ts` | Rules for Observation writes: kept row references and extensions |
| `src/http/observation.ts` | Create and update through both versions for Observation |
| `fhir/r4/` | Local FHIR package with the server's own R4 conformance resources (the `class-r6` SearchParameter), loaded by the canonical manager |
| `fml-maps/` | FML StructureMaps. `R4_R6` is generated, `R6_R4` holds its datatype maps reversed, `BodyStructure` is hand-written in both, and `Patient`, `Encounter`, `Resource` and `DomainResource` in `R6_R4` are hand-written reverses of the generated maps |
| `docs/mappings.html` | Diagrams of how resources map between versions. Open it in a browser |
| `postman/fml-r4-r6.postman_collection.json` | Runnable examples with assertions. Import it into Postman, or run `newman run` on it with the server up |
| `src/fhir-types/` | Types generated by `@atomic-ehr/codegen` (`bun run generate-types`) |

## Storage

Each resource type gets two tables, for example `patient` and `patient_history`:

- `patient(id, version_id, last_updated, resource jsonb)` holds the current version
- `patient_history(id, version_id, last_updated, resource jsonb)` holds every version; a delete is a row with `resource = NULL`

Both tables contain R4 JSON. Mapping is performed only when an R6 representation
is requested.

### Looking at the database

Use the `psql` that is inside the container, so you don't need a local install. Run this from the project folder:

```sh
docker compose exec db psql -U fhir
```

```sql
\dt                                   -- list tables (patient, patient_history)
\d patient                            -- show the columns of a table
SELECT id, version_id, last_updated FROM patient;
SELECT jsonb_pretty(resource) FROM patient LIMIT 1;     -- the stored FHIR JSON
SELECT id, version_id, resource IS NULL AS deleted FROM patient_history ORDER BY last_updated;
\q                                    -- quit
```

To run a single query without opening the prompt:

```sh
docker compose exec db psql -U fhir -c "SELECT id, version_id FROM patient"
```

To connect from a GUI client (DBeaver, TablePlus, DataGrip, Postico) or a local `psql` (`brew install libpq`), use `postgres://fhir:fhir@localhost:5437/fhir`:

| | |
|---|---|
| Host | `localhost` |
| Port | `5437` |
| Database | `fhir` |
| User / password | `fhir` / `fhir` |

### One R6 resource as several R4 rows

R6 `BodyStructure.includedStructure` repeats, but R4 `location` and `morphology` hold one value, so each structure is its own R4 row: `<id>`, `<id>--2`, `<id>--3`. `--` is reserved in ids.

- A write to any row rewrites the whole group in one transaction, and every write must be valid in both R4 and R6 before it commits.
- A row keeps its id while its structure exists, and numbers are never reused. R6 shows it as `includedStructure.id`. The one exception: if the primary row's structure is removed, the next one moves into the primary row.
- Rows carry a server-managed extension with their position. Secondary rows link to the primary row, and the primary row lists the others in order.
- R6-only elements are kept in R4 extensions. An R4 PUT with no `extension` array keeps them. One with an array states the client's intent, and `X-Replace-Extensions: true` removes them when no array would remain.
- Extensions we don't recognise are carried across: one on the R6 resource is shared by every row, and one on a structure or written on an R4 row stays with that structure. URLs our mapping uses are reserved.
- Content the server can't carry safely returns `422` rather than being lost. See `docs/mappings.html` for the list.

### Observation through both versions

One R6 Observation is one R4 row. Every write, from either version, must be valid in both, and anything that wouldn't survive the conversion returns `422`. Elements only R6 has (`statusReason`, `organizer`, `triggeredBy`, `context`, `supportingDevice`, `referenceRange.normalValue`, Attachment values) are kept in R4 extensions, with the same rule for an R4 PUT that leaves them out as BodyStructure. `contained`, `modifierExtension` and `implicitRules` return `422` through both versions.

### References to a BodyStructure

R4 has no core element for these, so an R4 Observation holds them as the standard `http://hl7.org/fhir/StructureDefinition/bodySite` extension on `bodySite`:

```json
{ "bodySite": { "text": "arm", "extension": [
  { "url": "http://hl7.org/fhir/StructureDefinition/bodySite",
    "valueReference": { "reference": "BodyStructure/abc--2" } } ] } }
```

- R4 stores it as sent, and it can point at one row.
- R6 reads it as `bodyStructure`, always pointing at the whole resource (`BodyStructure/abc`). Rows of one group become one entry. R6 can't tell which structure was meant.
- An R6 write of `BodyStructure/abc` is stored as one link per R4 row (`abc`, `abc--2`, `abc--3`), so an R4 client sees every structure it meant. The rows are found by resolving `abc` against storage and following its row-group `member` links, at write time. Rows added to the BodyStructure later aren't added to existing links.
- If the stored resource already links to that BodyStructure, an R6 write keeps those links (one row, some or all), so an R6 client can't widen what an R4 client narrowed.
- If a structure moves into the primary row, Observations referencing its old row are changed to reference the primary row in the same transaction, each with a new version.
- The form is checked on R4 writes and returns `422`: it must be a `valueReference` to a BodyStructure, and can't be version-specific, contained, or an absolute URL on this server. Whether the target exists isn't checked.
- An R6 write stores `bodyStructure` as the same extension, always to the whole resource. A row id or a `concept` returns `422`. If R4 already stored a row reference to that resource, an R6 update keeps it, and leaving the resource out removes it.
- Only Observation does this so far. See `docs/mappings.html` for examples in both directions, the limits, and how to add another type.

### Adding a resource type

To add a resource type, add it to `STORED_RESOURCE_TYPES` in `src/db/index.ts`. It can be read through `/R6` once it has an R4 → R6 map. To write it through `/R6`, it also needs an R6 → R4 map and handlers: `GROUPED` in `src/http/server.ts` for a type stored as linked rows, `CROSS_VERSION` for a type stored as one row. Also add it to the tree-shake list in `scripts/generate-types.ts` if you want its TypeScript types.
