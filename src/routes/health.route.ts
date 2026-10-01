import { Hono } from "hono";
import type { AppEnv } from "../types/hono.js";
export const healthRoute = new Hono<AppEnv>();
healthRoute.get("/", (c) =>
  c.json({
    message: "ok",
    service: "rhythmeta-backend",
    timestamp: new Date().toISOString(),
  }),
);
healthRoute.get("/database", async (c) => {
  await c.env.DB.prepare("SELECT 1").first();
  return c.json({ message: "ok", timestamp: new Date().toISOString() });
});
