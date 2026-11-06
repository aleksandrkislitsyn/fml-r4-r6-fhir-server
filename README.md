# fml-r4-r6-fhir-server

A sample FHIR server on Bun and PostgreSQL 18. Every resource is stored as FHIR **R4**. `/R4` reads and writes the stored data directly. `/R6` is a read-only facade that executes FHIR Mapping Language (FML) maps over the stored R4 content.

## Status

- [x] R4 `Patient` CRUD: create, read, update (including create-on-update), delete, versioning, `If-Match`
- [x] Validation of R4 resources with `@atomic-ehr/fhirschema`; core packages are loaded by `@atomic-ehr/fhir-canonical-manager`
- [x] One table per resource type, plus a history table
- [x] R4 → R6 FML execution using the TypeScript FHIRPath Lab executor
- [x] `/R6/Patient/:id` reads and `/R6/metadata`
- [ ] R6 writes (reverse maps and R6 input validation are still needed)
- [x] R4 Encounter CRUD and native `class` token search
- [x] R6 Encounter class search over native R4 class and cross-version extensions
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

The default map folder is `fml-maps/R4_R6/maps/StructureMaps`. To use maps
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
success. R6 `POST`, `PUT`, and `DELETE` return `405`.

The maps remain draft R6-ballot5 maps, not a production conformance guarantee.
Preparation warnings are logged as a diagnostic count. The converted Encounter
fixture is validated against R6 ballot5 in the integration tests; runtime output
validation, history interactions, terminology services, and external reference
resolution are not implemented. Patient and Encounter have storage and HTTP support.
`bun test` runs the server's `test/` suite; the vendored Lab has its own tests.

### Encounter class search (R4)

```sh
curl -G localhost:8080/R4/Encounter \
  --data-urlencode 'class=http://terminology.hl7.org/CodeSystem/v3-ActCode|AMB'
```

Returns a `Bundle` of type `searchset`. Searches the native R4 `Encounter.class`
Coding only; `xver/encounter-class` extensions do not match this R4 parameter.
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
`extension.where(url = 'xver/encounter-class').valueCodeableConcept.coding`.
System and code must match the same Coding. Each Encounter is returned once,
even when both the native field and extensions match.

Search results use the same injected FML converter as individual R6 reads,
including cancellation and diagnostic handling. The response contains R6
Encounters with `class` as an array of CodeableConcepts. The consumed
`xver/encounter-class` extension is omitted from the R6 representation, while
the stored R4 resource remains unchanged. R6 writes still return `405`.
Token syntax and search limitations are the same as R4.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | Entry point: migrate, load the R4 validator, inject the converter, start `Bun.serve` |
| `src/http/server.ts` | Routing for `/R4` and `/R6` and the FHIR REST interactions |
| `src/db/index.ts` | Postgres connection (`Bun.SQL`), the list of stored resource types, migrations |
| `src/db/repository.ts` | Version-aware create, read, update and delete over `<type>` and `<type>_history` tables |
| `src/fhir/validator.ts` | Loads the core package and builds FHIRSchemas used for validation |
| `src/fhir/convert.ts` | Injectable R4 → R6 converter with cached preparation and execution |
| `src/fhir/maps.ts` | Configured filesystem map catalog and source/target type selection |
| `scripts/build-fml.ts` | Builds the pinned engine without installing the Lab application |
| `vendor/fhirpath-lab/` | Pinned executor/validator source submodule |
| `fml-maps/` | FML StructureMaps for R4 → R6 (draft, generated) |
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

### Adding a resource type

To add a resource type, add it to `STORED_RESOURCE_TYPES` in `src/db/index.ts`. Also add it to the tree-shake list in `scripts/generate-types.ts` if you want its TypeScript types.
