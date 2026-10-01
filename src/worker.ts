import { createApp, registerOpenApiRoutes, services } from "./app.js";
import type { AppEnv } from "./types/hono.js";
import { CommunityAliasService } from "./services/community-alias.service.js";
import { BackupService } from "./services/backup.service.js";
import document from "../openapi.generated.json";
const app = createApp();
registerOpenApiRoutes(app, document);
export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: AppEnv["Bindings"]) {
    for (const game of ["maimaid", "chunithmd"] as const)
      await services(env, game)(CommunityAliasService).rollCycle();
    await services(env)(BackupService).cleanup();
    const date = new Date(controller.scheduledTime);
    if (date.getUTCHours() === 0 && date.getUTCMinutes() === 0) {
      const now = date.toISOString();
      await env.DB.batch([
        env.DB.prepare("DELETE FROM auth_challenges WHERE expiresAt<?").bind(
          now,
        ),
        env.DB.prepare("DELETE FROM refresh_tokens WHERE expiresAt<?").bind(
          now,
        ),
        env.DB.prepare(
          "DELETE FROM rate_limit_counters WHERE windowEnd<?",
        ).bind(controller.scheduledTime),
      ]);
    }
  },
};
