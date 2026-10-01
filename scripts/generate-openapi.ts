import { writeFile } from "node:fs/promises";
import { createApp } from "../src/app.js";
import { buildOpenApiDocument } from "../src/openapi.js";
import type { Env } from "../src/env.js";
const document = buildOpenApiDocument(createApp(), {
  APP_PUBLIC_URL: "https://api.rhythmeta.org",
  PORT: 8787,
} as Env);
await writeFile(
  new URL("../openapi.generated.json", import.meta.url),
  JSON.stringify(document, null, 2) + "\n",
);
