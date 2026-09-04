import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { format } from "prettier";
import { z } from "zod";

import { ProtocolSchemas } from "./schemas.js";

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, sortObject(nested)]),
  );
}

export async function generateProtocolSchemas(
  outputDirectory = resolve(process.cwd(), "packages/protocol/schemas"),
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  for (const [name, schema] of Object.entries(ProtocolSchemas).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const jsonSchema = z.toJSONSchema(schema, { target: "draft-2020-12" });
    const contents = await format(JSON.stringify(sortObject(jsonSchema)), {
      parser: "json",
    });
    await writeFile(
      resolve(outputDirectory, `${name}.schema.json`),
      contents,
      "utf8",
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await generateProtocolSchemas();
}
