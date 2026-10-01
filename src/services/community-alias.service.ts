import { inject, injectable } from "tsyringe";
import { TOKENS } from "../di/tokens.js";
import { Database, nowISO, type Game, type SqlValue } from "../db/database.js";
import { AppError } from "../lib/errors.js";
import type { Env } from "../env.js";

type Candidate = {
  id: string;
  game: Game;
  songIdentifier: string;
  aliasText: string;
  aliasNorm: string;
  submitterId: string;
  status: "voting" | "approved" | "rejected";
  rejectionSource: string | null;
  voteCloseAt: string | null;
  createdAt: string;
  updatedAt: string;
};
const indexCache = new Map<
  string,
  { until: number; songs: Record<string, string[]> }
>();
export const normalizeAlias = (value: string) =>
  value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s]+/gu, "")
    .replace(
      /[\p{P}\p{S}，。！？、；：·・•（）【】《》〈〉「」『』“”‘’—～＿－…￥]+/gu,
      "",
    );
const today = () =>
  new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const detailSelect = `SELECT c.*,c.id AS candidateId,u.username||'#'||u.usernameDiscriminator AS submitterHandle,
 (SELECT COUNT(*) FROM community_alias_votes WHERE candidateId=c.id AND vote=1) AS supportCount,
 (SELECT COUNT(*) FROM community_alias_votes WHERE candidateId=c.id AND vote=-1) AS opposeCount
 FROM community_alias_candidates c JOIN users u ON u.id=c.submitterId`;

@injectable()
export class CommunityAliasService {
  constructor(
    @inject(TOKENS.Database) private readonly db: Database,
    @inject(TOKENS.Env) private readonly env: Env,
    readonly game: Game = "maimaid",
  ) {}
  normalizeAlias = normalizeAlias;
  private async catalogAliases(songIdentifier: string) {
    const base =
      this.game === "maimaid"
        ? this.env.MAIMAID_STATIC_URL
        : this.env.CHUNITHMD_STATIC_URL;
    let cached = indexCache.get(base);
    if (!cached || cached.until < Date.now()) {
      const response = await fetch(`${base}/community-index.json`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new AppError(
          503,
          "catalog_unavailable",
          "Song index is temporarily unavailable.",
        );
      const data = (await response.json()) as {
        songs: Record<string, string[]>;
      };
      if (!data.songs || typeof data.songs !== "object")
        throw new AppError(503, "catalog_unavailable", "Invalid song index.");
      cached = { songs: data.songs, until: Date.now() + 300_000 };
      indexCache.set(base, cached);
    }
    if (!Object.hasOwn(cached.songs, songIdentifier))
      throw new AppError(404, "song_not_found", "Song does not exist.");
    return cached.songs[songIdentifier];
  }
  async submitAlias(input: {
    userId: string;
    isAdmin: boolean;
    songIdentifier: string;
    aliasText: string;
    deviceLocalDate?: string;
    tzOffsetMinutes?: number;
  }) {
    const text = input.aliasText.trim(),
      norm = normalizeAlias(text);
    if (!norm || text.length > 64)
      throw new AppError(400, "invalid_request", "Alias is invalid.");
    const external = await this.catalogAliases(input.songIdentifier);
    const match = external.find((value) => normalizeAlias(value) === norm);
    if (match)
      return {
        status: "rejected_duplicate",
        duplicateReason: "lxns_existing",
        message: "Alias already exists.",
        similarAliases: [match],
        candidate: null,
      };
    const duplicate = await this.db.get<Candidate>(
      `SELECT * FROM community_alias_candidates WHERE game=? AND songIdentifier=? AND aliasNorm=? AND (status IN ('voting','approved') OR rejectionSource='admin_manual') ORDER BY createdAt DESC LIMIT 1`,
      this.game,
      input.songIdentifier,
      norm,
    );
    const alias = await this.db.get<{ aliasText: string }>(
      "SELECT aliasText FROM aliases WHERE game=? AND songIdentifier=? AND aliasNorm=?",
      this.game,
      input.songIdentifier,
      norm,
    );
    if (
      alias ||
      (duplicate &&
        (duplicate.rejectionSource !== "admin_manual" || !input.isAdmin))
    )
      return {
        status: "rejected_duplicate",
        duplicateReason:
          duplicate?.rejectionSource === "admin_manual"
            ? "admin_rejected_locked"
            : "community_existing",
        message: "Alias already exists or was rejected by an administrator.",
        similarAliases: [alias?.aliasText ?? duplicate!.aliasText],
        candidate: null,
      };
    const id = crypto.randomUUID(),
      now = nowISO();
    const result = await this.db.run(
      `INSERT INTO community_alias_candidates(id,game,songIdentifier,aliasText,aliasNorm,submitterId,status,voteOpenAt,voteCloseAt,submittedLocalDate,createdAt,updatedAt)
   SELECT ?,?,?,?,?,?,'voting',?,?,?,?,? WHERE (SELECT COUNT(*) FROM community_alias_candidates WHERE game=? AND submitterId=? AND submittedLocalDate=?)<5`,
      id,
      this.game,
      input.songIdentifier,
      text,
      norm,
      input.userId,
      now,
      new Date(Date.now() + 72 * 3600_000).toISOString(),
      today(),
      now,
      now,
      this.game,
      input.userId,
      today(),
    );
    if (!result.meta.changes)
      return {
        status: "quota_exceeded",
        message: "Daily submission quota reached.",
        quotaRemaining: 0,
      };
    return {
      status: "created",
      message: "Alias submitted for 72 hours of voting.",
      candidate: await this.candidate(id),
      quotaRemaining: Math.max(
        0,
        5 - (await this.fetchMyDailyCount(input.userId)),
      ),
    };
  }
  private async candidate(id: string) {
    const row = await this.db.get<Candidate>(
      "SELECT * FROM community_alias_candidates WHERE id=? AND game=?",
      id,
      this.game,
    );
    if (!row)
      throw new AppError(404, "candidate_not_found", "Candidate not found.");
    return row;
  }
  async fetchVotingBoard(userId: string | null, limit: number, offset: number) {
    const now = nowISO();
    return this.db.all(
      `${detailSelect.replace(" FROM community_alias_candidates c", `,(SELECT vote FROM community_alias_votes WHERE candidateId=c.id AND voterId=?) AS myVote FROM community_alias_candidates c`)} WHERE c.game=? AND c.status='voting' AND (c.voteOpenAt IS NULL OR c.voteOpenAt<=?) AND (c.voteCloseAt IS NULL OR c.voteCloseAt>?) ORDER BY c.voteCloseAt,c.createdAt DESC LIMIT ? OFFSET ?`,
      userId,
      this.game,
      now,
      now,
      Math.min(200, limit),
      offset,
    );
  }
  async fetchMyCandidates(userId: string, limit: number, song?: string) {
    return this.db.all(
      `${detailSelect} WHERE c.game=? AND c.submitterId=? AND (? IS NULL OR c.songIdentifier=?) ORDER BY c.createdAt DESC LIMIT ?`,
      this.game,
      userId,
      song ?? null,
      song ?? null,
      Math.min(200, limit),
    );
  }
  async fetchMyDailyCount(userId: string, _date?: string) {
    return (await this.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM community_alias_candidates WHERE game=? AND submitterId=? AND submittedLocalDate=?",
      this.game,
      userId,
      today(),
    ))!.count;
  }
  async vote(userId: string, id: string, vote: number) {
    const candidate = await this.candidate(id),
      now = nowISO();
    if (
      candidate.status !== "voting" ||
      (candidate.voteCloseAt && candidate.voteCloseAt <= now)
    )
      throw new AppError(400, "candidate_not_voting", "Voting is closed.");
    // Same vote toggles off. A changed vote is updated atomically, including the deadline check.
    const open =
      "EXISTS(SELECT 1 FROM community_alias_candidates WHERE id=? AND game=? AND status='voting' AND (voteOpenAt IS NULL OR voteOpenAt<=?) AND (voteCloseAt IS NULL OR voteCloseAt>?))";
    const results = await this.db.batch([
      this.db.statement(
        `DELETE FROM community_alias_votes WHERE candidateId=? AND voterId=? AND vote=? AND ${open}`,
        id,
        userId,
        vote,
        id,
        this.game,
        now,
        now,
      ),
      this.db.statement(
        `INSERT INTO community_alias_votes(id,candidateId,voterId,vote,createdAt,updatedAt)
    SELECT ?,?,?,?,?,? WHERE changes()=0 AND ${open}
    ON CONFLICT(candidateId,voterId) DO UPDATE SET vote=excluded.vote,updatedAt=excluded.updatedAt`,
        crypto.randomUUID(),
        id,
        userId,
        vote,
        now,
        now,
        id,
        this.game,
        now,
        now,
      ),
    ]);
    if (!results[0].meta.changes && !results[1].meta.changes)
      throw new AppError(400, "candidate_not_voting", "Voting is closed.");
    const counts = await this.db.get<{
      supportCount: number;
      opposeCount: number;
    }>(
      "SELECT COUNT(CASE WHEN vote=1 THEN 1 END) AS supportCount,COUNT(CASE WHEN vote=-1 THEN 1 END) AS opposeCount FROM community_alias_votes WHERE candidateId=?",
      id,
    );
    return {
      candidateId: id,
      myVote: results[0].meta.changes ? null : vote,
      ...counts,
    };
  }
  async approvedSync(_since: Date | null, _limit: number) {
    return this.db.all(
      `SELECT id AS candidateId,songIdentifier,aliasText,status,updatedAt,createdAt AS approvedAt FROM aliases WHERE game=? AND source='community' ORDER BY updatedAt,id`,
      this.game,
    );
  }
  async rollCycle() {
    const ids = await this.db.all<{ id: string }>(
      "SELECT id FROM community_alias_candidates WHERE game=? AND status='voting' AND voteCloseAt<=? ORDER BY voteCloseAt LIMIT 100",
      this.game,
      nowISO(),
    );
    let settledCount = 0;
    for (const { id } of ids) {
      const now = nowISO();
      const approval = `((SELECT COUNT(*) FROM community_alias_votes WHERE candidateId=community_alias_candidates.id AND vote=1)>=3 AND (SELECT COALESCE(SUM(vote),0) FROM community_alias_votes WHERE candidateId=community_alias_candidates.id)>0)`;
      const results = await this.db.batch([
        this.db.statement(
          `UPDATE community_alias_candidates SET status=CASE WHEN ${approval} THEN 'approved' ELSE 'rejected' END,rejectionSource=CASE WHEN ${approval} THEN NULL ELSE 'community_vote' END,approvedAt=CASE WHEN ${approval} THEN ? ELSE NULL END,rejectedAt=CASE WHEN ${approval} THEN NULL ELSE ? END,updatedAt=? WHERE id=? AND game=? AND status='voting' AND voteCloseAt<=?`,
          now,
          now,
          now,
          id,
          this.game,
          now,
        ),
        this.aliasUpsert(id),
      ]);
      settledCount += results[0].meta.changes;
    }
    return { settledCount };
  }
  private aliasUpsert(id: string) {
    return this.db.statement(
      `INSERT INTO aliases(id,game,songIdentifier,aliasText,aliasNorm,source,status,createdAt,updatedAt)
   SELECT id,game,songIdentifier,aliasText,aliasNorm,'community','approved',createdAt,updatedAt FROM community_alias_candidates WHERE id=? AND game=? AND status='approved'
   ON CONFLICT(game,songIdentifier,aliasNorm,source) DO UPDATE SET aliasText=excluded.aliasText,status='approved',updatedAt=excluded.updatedAt`,
      id,
      this.game,
    );
  }
  async adminDashboardStats() {
    return this.db.get(
      `SELECT COUNT(*) AS totalCount,COUNT(CASE WHEN status='voting' THEN 1 END) AS votingCount,COUNT(CASE WHEN status='approved' THEN 1 END) AS approvedCount,COUNT(CASE WHEN status='rejected' THEN 1 END) AS rejectedCount,COUNT(CASE WHEN status='voting' AND voteCloseAt<=? THEN 1 END) AS expiredVotingCount,COUNT(CASE WHEN status='voting' AND voteCloseAt>? AND voteCloseAt<=? THEN 1 END) AS closingSoonCount,COUNT(CASE WHEN submittedLocalDate=? THEN 1 END) AS todaySubmissions FROM community_alias_candidates WHERE game=?`,
      nowISO(),
      nowISO(),
      new Date(Date.now() + 86400_000).toISOString(),
      today(),
      this.game,
    );
  }
  async adminListCandidates(input: {
    status?: string | null;
    search?: string | null;
    sort?: string | null;
    limit: number;
    offset: number;
  }) {
    const sorts: Record<string, string> = {
      deadline_asc: "c.voteCloseAt ASC",
      created_desc: "c.createdAt DESC",
      created_asc: "c.createdAt ASC",
      updated_asc: "c.updatedAt ASC",
      updated_desc: "c.updatedAt DESC",
    };
    const filter = `c.game=? AND (?='all' OR c.status=?) AND (c.songIdentifier LIKE ? OR c.aliasText LIKE ?)`;
    const status = input.status ?? "all",
      search = `%${input.search ?? ""}%`,
      values: SqlValue[] = [this.game, status, status, search, search];
    const count = await this.db.get<{ totalCount: number }>(
      `SELECT COUNT(*) AS totalCount FROM community_alias_candidates c WHERE ${filter}`,
      ...values,
    );
    const rows = await this.db.all<Record<string, unknown>>(
      `${detailSelect} WHERE ${filter} ORDER BY ${sorts[input.sort ?? "updated_desc"] ?? sorts.updated_desc} LIMIT ? OFFSET ?`,
      ...values,
      input.limit,
      input.offset,
    );
    return rows.map((row) => ({ ...row, totalCount: count!.totalCount }));
  }
  async adminCreateCandidate(input: {
    submitterId: string;
    songIdentifier: string;
    aliasText: string;
    status: "voting" | "approved";
  }) {
    await this.catalogAliases(input.songIdentifier);
    const norm = normalizeAlias(input.aliasText),
      id = crypto.randomUUID(),
      now = nowISO();
    if (!norm) throw new AppError(400, "invalid_request", "Invalid alias.");
    await this.db.batch([
      this.db.statement(
        "INSERT INTO community_alias_candidates(id,game,songIdentifier,aliasText,aliasNorm,submitterId,status,voteOpenAt,voteCloseAt,approvedAt,submittedLocalDate,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id,
        this.game,
        input.songIdentifier,
        input.aliasText.trim(),
        norm,
        input.submitterId,
        input.status,
        now,
        new Date(Date.now() + 72 * 3600_000).toISOString(),
        input.status === "approved" ? now : null,
        today(),
        now,
        now,
      ),
      this.aliasUpsert(id),
    ]);
    return this.candidate(id);
  }
  async adminSetStatus(id: string, status: "voting" | "approved" | "rejected") {
    const row = await this.candidate(id),
      now = nowISO();
    await this.db.batch([
      this.db.statement(
        "UPDATE community_alias_candidates SET status=?,rejectionSource=?,approvedAt=?,rejectedAt=?,voteOpenAt=?,voteCloseAt=?,updatedAt=? WHERE id=? AND game=?",
        status,
        status === "rejected" ? "admin_manual" : null,
        status === "approved" ? now : null,
        status === "rejected" ? now : null,
        now,
        status === "voting"
          ? new Date(Date.now() + 72 * 3600_000).toISOString()
          : now,
        now,
        id,
        this.game,
      ),
      this.db.statement(
        "UPDATE aliases SET status='rejected',updatedAt=? WHERE game=? AND songIdentifier=? AND aliasNorm=? AND source='community' AND ?<>'approved'",
        now,
        this.game,
        row.songIdentifier,
        row.aliasNorm,
        status,
      ),
      this.aliasUpsert(id),
    ]);
    return this.candidate(id);
  }
  async adminUpdateVoteWindow(id: string, close: Date) {
    await this.candidate(id);
    if (close <= new Date())
      throw new AppError(
        400,
        "invalid_vote_close_at",
        "Deadline must be in the future.",
      );
    await this.db.run(
      "UPDATE community_alias_candidates SET voteOpenAt=?,voteCloseAt=?,updatedAt=? WHERE id=? AND game=? AND status='voting'",
      nowISO(),
      close.toISOString(),
      nowISO(),
      id,
      this.game,
    );
    return this.candidate(id);
  }
}
