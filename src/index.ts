import { migrate } from "./db/index.ts";
import { loadValidator } from "./fhir/validator.ts";
import { createHandler } from "./http/server.ts";
import { createFmlConverter } from "./fhir/convert.ts";

await migrate();
const [r4, r6] = await Promise.all([loadValidator("R4"), loadValidator("R6")]);
const converter = createFmlConverter();

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8080),
  idleTimeout: 60,
  fetch: createHandler({ validators: { R4: r4, R6: r6 }, converter }),
});

console.log(`FHIR server listening on ${server.url}  (R4: ${server.url}R4, R6: ${server.url}R6)`);
