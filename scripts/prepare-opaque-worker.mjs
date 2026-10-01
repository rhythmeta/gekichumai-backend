import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
const require = createRequire(import.meta.url);
const entry = require.resolve("@serenity-kit/opaque");
const packageRoot = resolve(dirname(entry), "..");
const source = await readFile(resolve(packageRoot, "esm/index.js"), "utf8");
const match = source.match(
  /function wasmData\(imports\)\{return _loadWasmModule\(0, null, '([^']+)'[^\n]+\}/,
);
if (!match)
  throw new Error("OPAQUE package format changed; review Worker WASM adapter.");
const target = new URL("../.worker-vendor/", import.meta.url);
await mkdir(target, { recursive: true });
await writeFile(
  new URL("opaque.wasm", target),
  Buffer.from(match[1], "base64"),
);
const glue =
  'import wasmModule from "./opaque.wasm";\n' +
  source
    .slice(source.indexOf(match[0]) + match[0].length)
    .replace("wasmData()", "wasmModule");
await writeFile(new URL("opaque.js", target), glue);
await copyFile(resolve(packageRoot, "LICENSE"), new URL("LICENSE", target));
