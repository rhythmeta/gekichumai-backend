import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const encoder = new TextEncoder();

export const ok = <T>(
  c: Context,
  data: T,
  status: ContentfulStatusCode = 200,
) => {
  const payload = JSON.stringify(data, (_, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  const contentLength = encoder.encode(payload).byteLength.toString();
  return c.body(payload, status, {
    "content-type": "application/json; charset=UTF-8",
    "content-length": contentLength,
  });
};
