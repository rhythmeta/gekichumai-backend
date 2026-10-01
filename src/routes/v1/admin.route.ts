import { Hono } from "hono";
import { z } from "zod";
import { adminRequired } from "../../middleware/auth.js";
import { CommunityAliasService } from "../../services/community-alias.service.js";
import { AdminUserService } from "../../services/admin-user.service.js";
import { ok } from "../../http/response.js";
import {
  createCustomMethodParamSchema,
  standardValidator,
  validationHook,
} from "../../http/validation.js";
import type { AppEnv } from "../../types/hono.js";

const createCandidateSchema = z.object({
  songIdentifier: z.string().min(1),
  aliasText: z.string().min(1).max(64),
  status: z.enum(["voting", "approved"]).default("approved"),
});

const setStatusSchema = z.object({
  status: z.enum(["voting", "approved", "rejected"]),
});

const voteWindowSchema = z.object({
  voteCloseAt: z.iso.datetime(),
});

const listUsersQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((value) => {
      const parsed = Number(value ?? 30);
      if (!Number.isFinite(parsed)) return 30;
      return Math.max(1, Math.min(200, Math.trunc(parsed)));
    }),
  offset: z
    .string()
    .optional()
    .transform((value) => {
      const parsed = Number(value ?? 0);
      if (!Number.isFinite(parsed)) return 0;
      return Math.max(0, Math.trunc(parsed));
    }),
});

const opaquePayloadSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => !value.includes("__proto__"),
    "Opaque payload is invalid.",
  );

const startCreateUserSchema = z.object({
  email: z.email(),
  registrationRequest: opaquePayloadSchema,
});

const finishCreateUserSchema = z.object({
  email: z.email(),
  registrationRecord: opaquePayloadSchema,
  passwordFingerprint: opaquePayloadSchema,
});

const listCandidatesQuerySchema = z.object({
  status: z.string().optional(),
  search: z.string().optional(),
  sort: z.string().optional(),
  limit: z
    .string()
    .optional()
    .transform((value) => {
      const parsed = Number(value ?? 30);
      if (!Number.isFinite(parsed)) return 30;
      return Math.max(1, Math.min(200, Math.trunc(parsed)));
    }),
  offset: z
    .string()
    .optional()
    .transform((value) => {
      const parsed = Number(value ?? 0);
      if (!Number.isFinite(parsed)) return 0;
      return Math.max(0, Math.trunc(parsed));
    }),
});

const candidateSetStatusParamSchema = createCustomMethodParamSchema(
  "candidateId",
  "setStatus",
  z.uuid(),
);

const candidateVoteWindowParamSchema = createCustomMethodParamSchema(
  "candidateId",
  "updateVoteWindow",
  z.uuid(),
);

const userIdParamSchema = z.object({
  userId: z.uuid(),
});

const sourceIdParamSchema = z.object({
  sourceId: z.uuid(),
});

export const adminV1Route = new Hono<AppEnv>();
export const accountAdminRoute = new Hono<AppEnv>();

accountAdminRoute.get("/admin/context", adminRequired, async (c) => {
  const auth = c.get("auth");
  if (!auth) {
    return ok(
      c,
      { code: "unauthorized", message: "Authentication required." },
      401,
    );
  }
  return ok(c, {
    userId: auth.userId,
    email: auth.email,
    isAdmin: auth.isAdmin,
  });
});

adminV1Route.get("/admin/dashboard", adminRequired, async (c) => {
  const communityAliasService = c.var.resolve(CommunityAliasService);
  const stats = await communityAliasService.adminDashboardStats();
  return ok(c, stats);
});

adminV1Route.get(
  "/admin/candidates",
  adminRequired,
  standardValidator("query", listCandidatesQuerySchema, validationHook),
  async (c) => {
    const communityAliasService = c.var.resolve(CommunityAliasService);
    const query = c.req.valid("query");

    const input: Parameters<CommunityAliasService["adminListCandidates"]>[0] = {
      limit: query.limit,
      offset: query.offset,
    };
    if (query.status !== undefined) input.status = query.status;
    if (query.search !== undefined) input.search = query.search;
    if (query.sort !== undefined) input.sort = query.sort;
    const rows = await communityAliasService.adminListCandidates(input);
    return ok(c, { rows });
  },
);

adminV1Route.post(
  "/admin/candidates",
  adminRequired,
  standardValidator("json", createCandidateSchema, validationHook),
  async (c) => {
    const communityAliasService = c.var.resolve(CommunityAliasService);
    const auth = c.get("auth");
    if (!auth) {
      return ok(
        c,
        { code: "unauthorized", message: "Authentication required." },
        401,
      );
    }
    const body = c.req.valid("json");
    const candidate = await communityAliasService.adminCreateCandidate({
      submitterId: auth.userId,
      songIdentifier: body.songIdentifier,
      aliasText: body.aliasText,
      status: body.status,
    });
    return ok(c, { candidate }, 201);
  },
);

adminV1Route.post(
  "/admin/candidates/:candidateId:setStatus",
  adminRequired,
  standardValidator("param", candidateSetStatusParamSchema, validationHook),
  standardValidator("json", setStatusSchema, validationHook),
  async (c) => {
    const communityAliasService = c.var.resolve(CommunityAliasService);
    const params = c.req.valid("param");
    const body = c.req.valid("json");
    const candidate = await communityAliasService.adminSetStatus(
      params.candidateId,
      body.status,
    );
    return ok(c, { candidate });
  },
);

adminV1Route.post(
  "/admin/candidates/:candidateId:updateVoteWindow",
  adminRequired,
  standardValidator("param", candidateVoteWindowParamSchema, validationHook),
  standardValidator("json", voteWindowSchema, validationHook),
  async (c) => {
    const communityAliasService = c.var.resolve(CommunityAliasService);
    const params = c.req.valid("param");
    const body = c.req.valid("json");
    const candidate = await communityAliasService.adminUpdateVoteWindow(
      params.candidateId,
      new Date(body.voteCloseAt),
    );
    return ok(c, { candidate });
  },
);

adminV1Route.post("/admin:rollCycle", adminRequired, async (c) => {
  const communityAliasService = c.var.resolve(CommunityAliasService);
  const result = await communityAliasService.rollCycle();
  return ok(c, result);
});

accountAdminRoute.get(
  "/admin/users",
  adminRequired,
  standardValidator("query", listUsersQuerySchema, validationHook),
  async (c) => {
    const adminUserService = c.var.resolve(AdminUserService);
    const query = c.req.valid("query");
    const result = await adminUserService.listUsers({
      limit: query.limit,
      offset: query.offset,
    });
    return ok(c, result);
  },
);

accountAdminRoute.post(
  "/admin/users:start",
  adminRequired,
  standardValidator("json", startCreateUserSchema, validationHook),
  async (c) => {
    const adminUserService = c.var.resolve(AdminUserService);
    const body = c.req.valid("json");
    const payload = await adminUserService.startOpaqueCreateUser(body);
    return ok(c, payload);
  },
);

accountAdminRoute.post(
  "/admin/users:finish",
  adminRequired,
  standardValidator("json", finishCreateUserSchema, validationHook),
  async (c) => {
    const adminUserService = c.var.resolve(AdminUserService);
    const body = c.req.valid("json");
    const user = await adminUserService.finishOpaqueCreateUser(body);
    return ok(c, { user }, 201);
  },
);

accountAdminRoute.delete(
  "/admin/users/:userId",
  adminRequired,
  standardValidator("param", userIdParamSchema, validationHook),
  async (c) => {
    const adminUserService = c.var.resolve(AdminUserService);
    const params = c.req.valid("param");
    const result = await adminUserService.deleteUser(params.userId);
    return ok(c, result);
  },
);
