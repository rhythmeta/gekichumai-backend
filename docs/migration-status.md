# Rhythmeta migration — 2026-10-01

## Production

- The owner confirmed the old PostgreSQL service stopped accepting writes and authorized the existing archive for final import.
- API: https://api.rhythmeta.org, Worker `gekichumai-backend`, native D1 `rhythmeta` (`8cf164dd-0277-4860-ba58-595ed35df784`). The existing zone route `api.rhythmeta.org/*` invokes this Worker; the stopped origin is not used.
- Dashboard: https://dash.rhythmeta.org, Worker `gekichumai-dashboard`, Next.js static export with a custom domain.
- Imported 204 accounts, 2 TOTP credentials, 3 passkeys, 20 recovery codes, 54 approved community aliases, 123 candidates and 317 votes. An additional 64 rejected-alias tombstones preserve revocation behavior. Foreign-key and SQLite integrity checks pass. Scheduled settlement resumes after deployment, so candidate status totals can subsequently change.
- Original archive SHA-256: `a5a809531f64b541b2c5bc07b1c557188b5ed048575aaa11ca3d3373c77ca007`. Private import material is excluded from Git.
- OPAQUE setup and passkey RP ID `rhythmeta.org` preserved. New JWT secret invalidates legacy sessions. Apps use S256 PKCE with exact registered callbacks and single-use codes.
- Legacy `/v1/*` returns 410. Cloud profiles/scores/imports/collections/multiplayer are retired; only accounts and community data were imported.
- Dedicated public R2 bucket `gekichumai-backups` (https://backups.rhythmeta.org) holds protobuf+gzip backups at random UUID keys. Authenticated management, signed upload, immutable verified commit, latest three per game/user, 64 MiB compressed/512 MiB raw. A one-day lifecycle rule covers `backup-uploads/`; public responses use no-store.

## Validation

- Backend: 14 tests including real local D1/R2, bcrypt/OPAQUE, PKCE/refresh single use, concurrent voting and upload limits, checksum rejection, retention and ownership isolation. Worker dry run passes.
- Dashboard: lint/static build passes; browser verified bcrypt and OPAQUE login, security, community and backup pages against staging.
- Real staging Worker: login, PKCE, signed R2 upload, immutable commit, checksum, public download/cache headers, deletion/404 and per-game isolation pass.
- maimaid: Android codec/PKCE tests and native compile pass; Swift protobuf fixture plus actual SwiftData replace and durable recovery tests pass.
- chunithmd: KMP owns account/PKCE/networking, protobuf+gzip and recovery coordination; shared Android/iOS tests and native compile pass. iOS currently exposes a catalog shell and preserves imported personal snapshots for future personal-data UI.
- Both games publish static catalogs independently; community-index.json is available from their static Workers. chunithmd publication verified all 1,995 jackets.

## Repositories and operations

- https://github.com/rhythmeta/gekichumai-backend
- https://github.com/rhythmeta/gekichumai-dashboard
- Both extracted repositories preserve their original subtree histories. Validation runs on pushes/PRs; production deployment is manually dispatched.
- Cloudflare API token/account ID supplied through organization Actions secrets. Backend application/R2 secrets are configured in the backend repository.
- Temporary staging Workers and D1 were removed after verification, including test accounts and imported credential copies. No ready/pending staging backup objects remained. Production smoke-test accounts and R2 objects were also removed; production remains at 204 accounts, 2 TOTP credentials, 3 passkeys and 20 recovery codes.
- Keep the original archive and stopped Docker service available for rollback. Reverting DNS/route alone does not merge newly created D1 accounts or aliases back into PostgreSQL; export and reconcile post-cutover writes before any rollback.
- Both repositories are public at the owner’s request so organization-level deployment Secrets are available on the current GitHub plan.
- API routing is managed separately from application deployments because the deployment token lacks Zone Routes permission. The existing proxied DNS record must remain; its origin need not run. Worker Custom Domain attachment was rejected because that DNS record already exists.

## Published client changes

- maimaid: https://github.com/rhythmeta/maimaid/pull/3
- chunithmd: https://github.com/rhythmeta/chunithmd/pull/1
- Both PRs are ready for review. Local native builds/tests passed; remote native packaging checks were still running at handoff. Native apps have not been released.
- Backend and dashboard validation and production deployments passed in GitHub Actions using organization Cloudflare secrets.
