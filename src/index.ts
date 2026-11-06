import { migrate } from "./db/index.ts";
import { loadValidator } from "./fhir/validator.ts";
import { createHandler } from "./http/server.ts";

await migrate();
const r4 = await loadValidator("R4");

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8080),
  fetch: createHandler({ validators: { R4: r4 } }),
});

console.log(`FHIR server listening on ${server.url}  (R4: ${server.url}R4, R6: ${server.url}R6)`);
