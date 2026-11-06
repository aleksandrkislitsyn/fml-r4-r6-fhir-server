# Project notes

Sample FHIR server: Bun + PostgreSQL 18, with `/R4` and `/R6` base URLs. All resources are stored as FHIR **R4**, one table per resource type plus `<type>_history`. `/R4` uses the stored data directly. `/R6` requests go through `src/fhir/convert.ts`, which runs FML (R4 → R6 on read, R6 → R4 on write). `BodyStructure` (`GROUPED` in `src/http/server.ts`) and `Observation` (`CROSS_VERSION`) are writable through `/R6`; other types are read through R4 → R6 maps and return 405 on R6 writes. See README.md for the layout and `docs/mappings.html` for diagrams.

- DB: `bun run db:up` (docker compose, port 5437). Tests are integration tests and need the DB.
- One R6 resource can be several R4 rows (`<id>`, `<id>--2`, ...). A write from either version rewrites the group in one transaction and must be valid in both versions (`src/http/grouped.ts`, `src/fhir/bodystructure.ts`). Row ids are stable and numbers are never reused (`assignRowIds`). Tests in `test/bodystructure-cross-version.test.ts` are the acceptance criteria.
- FML runs on the executor in the `vendor/fhirpath-lab` submodule (`git submodule update --init --recursive`, then `bun run build:fml`). It refuses cross-version writes without a mapping, so values go through datatype maps: `fml-maps/R6_R4/*_6to4.fml` are reversed from the generated `R4_R6` ones. `docs/mappings.html` lists the map style it needs.
- Writes in `src/http/grouped.ts` and `src/http/observation.ts` convert and convert back, returning 422 for anything that would be lost. Unmapped content is caught by that check, so a map can leave out what R4 can't hold.
- Observation is one R4 row. R6-only elements are R4 extensions (`Observation_6to4.fml`, `Observation_4to6.fml`). Rules are in `src/fhir/observation.ts`. Tests: `test/observation-crud.test.ts`.
- References to a BodyStructure: R4 holds them in the `bodySite` extension on `Observation.bodySite`, possibly to one row. The R6 read maps them to `bodyStructure` and always the whole resource (`BodySiteReference_4to6.fml`, `withUniqueBodyStructures`). An R6 write stores a link to every row: `withAllBodyStructureRows` in `toR4` resolves the primary row (`resolveStored`) and follows its `member` links. The target is to do this in `Observation_6to4.fml` with `resolve()`, which needs the engine to keep a resolved resource's type. If the stored resource already links to a group, `keepRowReferences` keeps exactly those links. When a structure moves into the primary row, `writeGroup` rewrites Observations referencing the old row in the same transaction. Tests: `test/observation-bodystructure-reference.test.ts`.
- `loadMapCatalog` treats only `<<type+>>` groups as a type's entry map. A group that should only run when called by name must be typed with no mode.
- Don't call `sql.close()` in tests: Bun shares the pool across test files.
- Check R6 element names against the pinned `6.0.0-ballot5` package in `.fhir/r6`, not build.fhir.org: the rolling build has elements the pinned package doesn't (e.g. `BodyStructure.predecessor`).
- Keep `docs/mappings.html` and `postman/` in line with the maps when mappings change.
- Validation: `@atomic-ehr/fhirschema`. Its `validate()` expects schemas already merged with their base chain. `src/fhir/validator.ts` flattens them (`mergeSchema`).
- Postgres: pass objects (not `JSON.stringify` strings) as jsonb parameters to `Bun.SQL`, or they get double-encoded as jsonb strings.
- Conformance resources the server defines itself (e.g. the `class-r6` SearchParameter) live in the local package `fhir/r4/`, loaded by the R4 canonical manager in `src/fhir/validator.ts`. Keep their `url` in sync with the CapabilityStatement in `src/http/server.ts`; a test checks every advertised definition resolves.
- Generated types in `src/fhir-types/` are produced by `bun run generate-types`; don't edit them by hand.


Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
