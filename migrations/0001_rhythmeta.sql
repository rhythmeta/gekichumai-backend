PRAGMA foreign_keys = ON;
CREATE TABLE users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 username TEXT NOT NULL, usernameNormalized TEXT NOT NULL, usernameDiscriminator TEXT NOT NULL,
 passwordHash TEXT, opaqueRegistrationRecord TEXT, passwordFingerprintHash TEXT,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 isAdmin INTEGER NOT NULL DEFAULT 0 CHECK(isAdmin IN (0,1)), authVersion INTEGER NOT NULL DEFAULT 0,
 emailVerifiedAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
 UNIQUE(usernameNormalized,usernameDiscriminator)
);
CREATE TABLE refresh_tokens (
 id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 tokenHash TEXT NOT NULL UNIQUE, expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL, revokedAt TEXT
);
CREATE INDEX refresh_expiry ON refresh_tokens(expiresAt);
CREATE INDEX refresh_user ON refresh_tokens(userId);
CREATE TABLE auth_challenges (
 id TEXT PRIMARY KEY, userId TEXT REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, tokenHash TEXT NOT NULL UNIQUE, payload TEXT NOT NULL DEFAULT '{}',
 expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL, consumedAt TEXT
);
CREATE INDEX challenge_expiry ON auth_challenges(expiresAt);
CREATE INDEX challenge_user ON auth_challenges(userId,kind);
CREATE TABLE user_totp_credentials (
 id TEXT PRIMARY KEY, userId TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 secretBase32 TEXT NOT NULL, enabledAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE TABLE user_passkey_credentials (
 id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 credentialId TEXT NOT NULL UNIQUE, publicKey BLOB NOT NULL, counter INTEGER NOT NULL DEFAULT 0,
 transports TEXT NOT NULL DEFAULT '[]', rpId TEXT NOT NULL, name TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE INDEX passkey_user ON user_passkey_credentials(userId);
CREATE TABLE user_mfa_backup_codes (
 id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 codeHash TEXT NOT NULL, createdAt TEXT NOT NULL, consumedAt TEXT, UNIQUE(userId,codeHash)
);
CREATE TABLE rate_limit_counters (
 bucket TEXT NOT NULL,keyHash TEXT NOT NULL,windowStart INTEGER NOT NULL,windowEnd INTEGER NOT NULL,count INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(bucket,keyHash,windowStart)
);
CREATE INDEX rate_expiry ON rate_limit_counters(windowEnd);
CREATE TABLE aliases (
 id TEXT PRIMARY KEY,game TEXT NOT NULL CHECK(game IN ('maimaid','chunithmd')),
 songIdentifier TEXT NOT NULL,aliasText TEXT NOT NULL,aliasNorm TEXT NOT NULL,source TEXT NOT NULL DEFAULT 'community',
 status TEXT NOT NULL DEFAULT 'approved',createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,
 UNIQUE(game,songIdentifier,aliasNorm,source)
);
CREATE INDEX alias_sync ON aliases(game,updatedAt,id);
CREATE TABLE community_alias_candidates (
 id TEXT PRIMARY KEY,game TEXT NOT NULL CHECK(game IN ('maimaid','chunithmd')),
 songIdentifier TEXT NOT NULL,aliasText TEXT NOT NULL,aliasNorm TEXT NOT NULL,
 submitterId TEXT NOT NULL REFERENCES users(id),status TEXT NOT NULL CHECK(status IN ('voting','approved','rejected')),
 rejectionSource TEXT,voteOpenAt TEXT,voteCloseAt TEXT,approvedAt TEXT,rejectedAt TEXT,
 submittedLocalDate TEXT NOT NULL,submittedTzOffsetMin INTEGER NOT NULL DEFAULT 480,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL
);
CREATE UNIQUE INDEX candidate_active ON community_alias_candidates(game,songIdentifier,aliasNorm) WHERE status IN ('voting','approved');
CREATE INDEX candidate_daily ON community_alias_candidates(game,submitterId,submittedLocalDate);
CREATE INDEX candidate_due ON community_alias_candidates(status,voteCloseAt);
CREATE TABLE community_alias_votes (
 id TEXT PRIMARY KEY,candidateId TEXT NOT NULL REFERENCES community_alias_candidates(id) ON DELETE CASCADE,
 voterId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,vote INTEGER NOT NULL CHECK(vote IN (-1,1)),
 createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,UNIQUE(candidateId,voterId)
);
CREATE TABLE backups (
 id TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),game TEXT NOT NULL CHECK(game IN ('maimaid','chunithmd')),
 objectKey TEXT NOT NULL UNIQUE,uploadKey TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','committing','ready','deleting')),
 formatVersion INTEGER NOT NULL,size INTEGER NOT NULL CHECK(size > 0 AND size <= 67108864),
 uncompressedSize INTEGER NOT NULL CHECK(uncompressedSize > 0 AND uncompressedSize <= 536870912),
 sha256 TEXT NOT NULL,deviceName TEXT NOT NULL,clientVersion TEXT NOT NULL,profileCount INTEGER NOT NULL CHECK(profileCount >= 0),
 createdAt TEXT NOT NULL,committedAt TEXT,leaseUntil TEXT,leaseToken TEXT
);
CREATE INDEX backups_owner ON backups(userId,game,state,committedAt);
CREATE INDEX backups_cleanup ON backups(state,createdAt);
