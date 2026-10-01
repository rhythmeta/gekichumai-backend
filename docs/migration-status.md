# Rhythmeta migration — 2026-10-01

## Production

- The owner confirmed the old PostgreSQL service stopped accepting writes and authorized the existing archive for final import.
- API: https://api.rhythmeta.org, Worker `rhythmeta-backend`, native D1 `rhythmeta` (`8cf164dd-0277-4860-ba58-595ed35df784`). The zone route `api.rhythmeta.org/*` intercepts the existing proxied DNS record.
- Dashboard: https://dash.rhythmeta.org, Worker `rhythmeta-dashboard`, Next.js static export with a custom domain.
- Imported 204 accounts, 2 TOTP credentials, 3 passkeys, 20 recovery codes, 54 approved community aliases, 123 candidates and 317 votes. An additional 64 rejected-alias tombstones preserve revocation behavior. Foreign-key and SQLite integrity checks pass. Scheduled settlement resumes after deployment, so candidate status totals can subsequently change.
- Original archive SHA-256: `a5a809531f64b541b2c5bc07b1c557188b5ed048575aaa11ca3d3373c77ca007`. Private import material is excluded from Git.
- OPAQUE setup and passkey RP ID `rhythmeta.org` preserved. New JWT secret invalidates legacy sessions. Apps use S256 PKCE with exact registered callbacks and single-use codes.
- Legacy `/v1/*` returns 410. Cloud profiles/scores/imports/collections/multiplayer are retired; only accounts and community data were imported.
- Public R2 bucket `maimaid-assets` holds protobuf+gzip backups at random UUID keys. Authenticated management, signed upload, immutable verified commit, latest three per game/user, 64 MiB compressed/512 MiB raw. A one-day lifecycle rule covers `backup-uploads/`; public responses use no-store.

## Validation

- Backend: 14 tests including real local D1/R2, bcrypt/OPAQUE, PKCE/refresh single use, concurrent voting and upload limits, checksum rejection, retention and ownership isolation. Worker dry run passes.
- Dashboard: lint/static build passes; browser verified bcrypt and OPAQUE login, security, community and backup pages against staging.
- Real staging Worker: login, PKCE, signed R2 upload, immutable commit, checksum, public download/cache headers, deletion/404 and per-game isolation pass.
- maimaid: Android codec/PKCE tests and native compile pass; Swift protobuf fixture plus actual SwiftData replace and durable recovery tests pass.
- chunithmd: KMP owns account/PKCE/networking, protobuf+gzip and recovery coordination; shared Android/iOS tests and native compile pass. iOS currently exposes a catalog shell and preserves imported personal snapshots for future personal-data UI.
- Both games publish static catalogs independently; community-index.json is available from their static Workers. chunithmd publication verified all 1,995 jackets.

## Repositories and operations

- https://github.com/rhythmeta/rhythmeta-backend
- https://github.com/rhythmeta/rhythmeta-dashboard
- Both extracted repositories preserve their original subtree histories. Validation runs on pushes/PRs; production deployment is manually dispatched.
- Cloudflare API token/account ID supplied through organization Actions secrets. Backend application/R2 secrets are configured in the backend repository.
- Staging API/dashboard use `rhythmeta-backend-staging.cqbe.workers.dev` and `rhythmeta-dashboard-staging.cqbe.workers.dev`; D1 staging is isolated from production. Two example.invalid test accounts exist only for staging verification.
- Keep the original archive and stopped Docker service available for rollback. Reverting DNS/route alone does not merge newly created D1 accounts or aliases back into PostgreSQL; export and reconcile post-cutover writes before any rollback.
- The API route relies on the existing proxied DNS record. Keep that record proxied until the API is moved to a Worker custom domain.
