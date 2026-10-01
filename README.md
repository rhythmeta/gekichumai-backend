# Rhythmeta backend

Shared Rhythmeta accounts, game-scoped community aliases and manual cloud backups for maimaid and chunithmd. Runs on Cloudflare Workers, D1 and the dedicated public R2 bucket `gekichumai-backups`.

- `/auth/v1`: OPAQUE/legacy bcrypt login, email verification/reset, MFA/passkeys, refresh tokens and PKCE app handoff.
- `/{maimaid,chunithmd}/v1/community`: aliases, voting and moderation.
- `/{maimaid,chunithmd}/v1/backups`: signed uploads, checksum-verified commit, latest three snapshots and deletion.
- `/health`, `/docs`, `/openapi.json`: service health and API documentation.
- Legacy `/v1/*` returns HTTP 410. Profiles, scores, imports, collections and multiplayer no longer live in the backend.

## Development

```sh
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
pnpm db:migrate
pnpm dev
pnpm test
pnpm build
```

Generate a development OPAQUE setup with `@serenity-kit/opaque`; never regenerate the production setup. `prepare:worker` extracts the package's WASM to a static Worker module because Workers cannot compile arbitrary WASM at runtime.

## Deploy

The `gekichumai-backend` Worker requires a D1 `DB` binding and an R2 `BACKUP_BUCKET` binding. Public settings and binding IDs are in `wrangler.jsonc`. Set `S3_BUCKET=gekichumai-backups` and `S3_PUBLIC_BASE_URL=https://backups.rhythmeta.org`; the S3 credentials must grant Object Read & Write to this bucket. Set the secrets listed in `.dev.vars.example` with `wrangler secret bulk`. Keep the existing OPAQUE setup and `WEBAUTHN_RP_ID=rhythmeta.org`. The dashboard origin is `https://dash.rhythmeta.org`.

The repository workflow validates every pull request. Production deployment is manually dispatched and requires `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` repository or organization secrets. R2 S3 credentials remain Worker secrets; a narrowly scoped token needs Workers deployment, D1 and R2 access.

The API zone route `api.rhythmeta.org/*` is already provisioned and is managed separately from application deployment. `wrangler.jsonc` intentionally omits production routes so the organization deployment token does not need Zone Routes permission. Keep the existing DNS record proxied. To reprovision the route, use an authorized Cloudflare account and `wrangler deploy --env="" --route "api.rhythmeta.org/*" --x-route-zones --zone-id 3842c59d03b6d2d937b84f679b3bdb8b`.

The minute cron settles closed alias votes and removes deleted/expired snapshots. Upload staging objects use `backup-uploads/`; configure a one-day R2 lifecycle expiry on that prefix, including objects re-uploaded through a still-valid five-minute upload URL. Final objects use `backups/{game}/{random UUID}.pb.gz`. Never cache either prefix at the public domain. All object responses carry `Cache-Control: no-store`.

Public download URLs are bearer links, as selected for this project. They must not appear in invocation logs, analytics or referrers. Authenticated routes control listing, upload, commit and deletion. A staging object and its committed object have different keys, so a reusable upload URL cannot overwrite a committed snapshot.

## PostgreSQL migration

```sh
python3 scripts/import-postgres-backup.py /private/maimaid.dump \
  --env-file /private/.env.docker --output .migration/run-001
```

The script fully reads the archive, selects only accounts/authentication credentials and community data, normalizes PostgreSQL representations, and rehearses all inserts in SQLite with integrity/foreign-key checks. The output contains credentials and is private/ignored. Never commit or upload it as a CI artifact.

Apply `migrations/0001_rhythmeta.sql` to an empty D1 database, then import the generated `data.sql`. Compare `report.json` counts before assigning production routes. Old sessions are intentionally invalidated. Keep the PostgreSQL archive and the old service available for rollback until the cutover is accepted.

## Snapshot contract

`protocol/backup.proto` is the portable wire contract. Clients gzip the protobuf, authenticate requests for signed upload URLs, and supply SHA-256 plus compressed/uncompressed sizes. Limits are 64 MiB compressed and 512 MiB uncompressed. Clients validate format/game/references, retain a durable local rollback, and replace personal data as one user operation. Static catalog assets and credentials are excluded.
