import { DatabaseSync } from "node:sqlite";

export type SqlValue = null | number | string | Uint8Array;
export type Row = Record<string, SqlValue>;

const MIGRATIONS = [
  `
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_iterations INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX sessions_user_id_idx ON sessions(user_id);
    CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

    CREATE TABLE wishlists (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      event_date TEXT,
      published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX wishlists_owner_id_idx ON wishlists(owner_id);

    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      wishlist_id TEXT NOT NULL REFERENCES wishlists(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      image_url TEXT,
      priority TEXT NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low', 'normal', 'high')),
      price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
      currency TEXT,
      note TEXT NOT NULL DEFAULT '',
      store_url TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      reserved_at INTEGER,
      reservation_token_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (
        (reserved_at IS NULL AND reservation_token_hash IS NULL) OR
        (reserved_at IS NOT NULL AND reservation_token_hash IS NOT NULL)
      )
    ) STRICT;
    CREATE INDEX items_wishlist_id_idx ON items(wishlist_id);
    CREATE INDEX items_wishlist_position_idx ON items(wishlist_id, position);
  `,
];

export class AppDatabase {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") {
      this.raw.exec("PRAGMA journal_mode = WAL");
      this.raw.exec("PRAGMA synchronous = NORMAL");
    }
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      ) STRICT
    `);
    const current = Number(
      this.raw.prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
      )
        .get()?.version ?? 0,
    );
    if (current > MIGRATIONS.length) {
      throw new Error(
        `Database schema version ${current} is newer than supported version ${MIGRATIONS.length}`,
      );
    }
    for (let index = current; index < MIGRATIONS.length; index++) {
      this.raw.exec("BEGIN IMMEDIATE");
      try {
        this.raw.exec(MIGRATIONS[index]);
        this.raw.prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
        ).run(index + 1, Date.now());
        this.raw.exec("COMMIT");
      } catch (error) {
        this.raw.exec("ROLLBACK");
        throw error;
      }
    }
  }

  close(): void {
    this.raw.close();
  }
}
