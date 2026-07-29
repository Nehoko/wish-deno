import { AppDatabase } from "./db.ts";
import {
  hashPassword,
  parseCookies,
  randomToken,
  sha256,
  timingSafeEqual,
  verifyPassword,
} from "./security.ts";

const SESSION_COOKIE = "wish_session";
const MAX_BODY_BYTES = 64 * 1024;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

type JsonObject = Record<string, unknown>;
type DbRow = Record<string, unknown>;

export interface AppOptions {
  databasePath?: string;
  publicDir?: string;
  secureCookies?: boolean;
  sessionTtlMs?: number;
  now?: () => number;
}

interface AuthContext {
  sessionId: string;
  userId: string;
  email: string;
  csrfToken: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "request_error",
  ) {
    super(message);
  }
}

class RateLimiter {
  #entries = new Map<string, { count: number; resetAt: number }>();

  allow(key: string, now: number, limit = 10, windowMs = 10 * 60_000): boolean {
    const entry = this.#entries.get(key);
    if (!entry || entry.resetAt <= now) {
      this.#entries.set(key, { count: 1, resetAt: now + windowMs });
      if (this.#entries.size > 2_000) {
        for (const [entryKey, value] of this.#entries) {
          if (value.resetAt <= now) this.#entries.delete(entryKey);
        }
      }
      return true;
    }
    entry.count++;
    return entry.count <= limit;
  }
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

async function readJson(request: Request): Promise<JsonObject> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json", "invalid_type");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "Request body too large", "body_too_large");
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "Request body too large", "body_too_large");
  }
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as JsonObject;
  } catch {
    throw new HttpError(400, "Invalid JSON body", "invalid_json");
  }
}

function requiredString(
  body: JsonObject,
  key: string,
  maxLength: number,
  minLength = 1,
): string {
  const value = body[key];
  if (typeof value !== "string") {
    throw new HttpError(400, `${key} must be a string`, "validation_error");
  }
  const normalized = value.trim();
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new HttpError(
      400,
      `${key} must be ${minLength}-${maxLength} characters`,
      "validation_error",
    );
  }
  return normalized;
}

function requiredSecret(body: JsonObject, key: string, maxLength: number): string {
  const value = body[key];
  if (typeof value !== "string" || value.length < 10 || value.length > maxLength) {
    throw new HttpError(
      400,
      `${key} must be 10-${maxLength} characters`,
      "validation_error",
    );
  }
  return value;
}

function optionalString(
  body: JsonObject,
  key: string,
  maxLength: number,
  options: { nullable?: boolean; trim?: boolean } = {},
): string | null | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value === null && options.nullable) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, `${key} must be a string`, "validation_error");
  }
  const normalized = options.trim === false ? value : value.trim();
  if (normalized.length > maxLength) {
    throw new HttpError(
      400,
      `${key} must be at most ${maxLength} characters`,
      "validation_error",
    );
  }
  return normalized;
}

function optionalBoolean(body: JsonObject, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new HttpError(400, `${key} must be boolean`, "validation_error");
  }
  return value;
}

function optionalInteger(
  body: JsonObject,
  key: string,
  minimum: number,
  maximum: number,
  nullable = false,
): number | null | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value === null && nullable) return null;
  if (
    !Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum
  ) {
    throw new HttpError(400, `${key} is invalid`, "validation_error");
  }
  return Number(value);
}

function optionalUrl(
  body: JsonObject,
  key: string,
): string | null | undefined {
  const value = optionalString(body, key, 2_048, { nullable: true });
  if (value === undefined || value === null || value === "") return value || null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
  } catch {
    throw new HttpError(400, `${key} must be an HTTP(S) URL`, "validation_error");
  }
  return value;
}

function publicUser(row: DbRow): JsonObject {
  return { id: row.id, email: row.email, createdAt: row.created_at };
}

function wishlistFromRow(row: DbRow): JsonObject {
  const result: JsonObject = {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    eventDate: row.event_date,
    published: Boolean(row.published),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.item_count !== undefined) result.itemCount = Number(row.item_count);
  if (row.reserved_count !== undefined) {
    result.reservedCount = Number(row.reserved_count);
  }
  return result;
}

function itemFromRow(row: DbRow, owner = false): JsonObject {
  const result: JsonObject = {
    id: row.id,
    wishlistId: row.wishlist_id,
    title: row.title,
    description: row.description,
    imageUrl: row.image_url,
    priority: row.priority,
    priceCents: row.price_cents,
    currency: row.currency,
    note: row.note,
    storeUrl: row.store_url,
    position: row.position,
    archived: Boolean(row.archived),
    reserved: row.reserved_at !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (owner) result.reservedAt = row.reserved_at;
  return result;
}

function securityHeaders(headers: Headers): void {
  headers.set(
    "content-security-policy",
    "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
}

function mimeType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
  }[extension] ?? "application/octet-stream";
}

export function createApp(options: AppOptions = {}) {
  const dataDir = Deno.env.get("DATA_DIR") ?? "/data";
  const databasePath = options.databasePath ?? Deno.env.get("DATABASE_PATH") ??
    `${dataDir.replace(/\/+$/, "")}/wish-deno.sqlite`;
  if (databasePath !== ":memory:") {
    const separator = databasePath.lastIndexOf("/");
    if (separator > 0) {
      Deno.mkdirSync(databasePath.slice(0, separator), { recursive: true });
    }
  }
  const db = new AppDatabase(databasePath);
  const publicDir = options.publicDir ?? Deno.env.get("PUBLIC_DIR") ?? "public";
  const secureSetting = Deno.env.get("COOKIE_SECURE");
  const secureCookies = options.secureCookies ??
    (secureSetting === undefined
      ? (Deno.env.get("APP_ORIGIN") ?? "").startsWith("https://")
      : secureSetting.toLowerCase() !== "false");
  const configuredTtlSeconds = Number(Deno.env.get("SESSION_TTL_SECONDS"));
  const sessionTtlMs = options.sessionTtlMs ??
    (Number.isFinite(configuredTtlSeconds) && configuredTtlSeconds > 0
      ? configuredTtlSeconds * 1_000
      : 30 * 24 * 60 * 60_000);
  const now = options.now ?? Date.now;
  const rateLimiter = new RateLimiter();

  const sessionCookie = (token: string): string => {
    const parts = [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${Math.floor(sessionTtlMs / 1000)}`,
    ];
    if (secureCookies) parts.push("Secure");
    return parts.join("; ");
  };

  const clearSessionCookie = (): string => {
    const parts = [
      `${SESSION_COOKIE}=`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=0",
    ];
    if (secureCookies) parts.push("Secure");
    return parts.join("; ");
  };

  async function authenticate(request: Request): Promise<AuthContext> {
    const token = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
    if (!token) throw new HttpError(401, "Authentication required", "unauthorized");
    const tokenHash = await sha256(token);
    const row = db.raw.prepare(`
      SELECT sessions.id AS session_id, sessions.user_id, sessions.csrf_token,
             sessions.expires_at, users.email
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?
    `).get(tokenHash) as DbRow | undefined;
    if (!row || Number(row.expires_at) <= now()) {
      if (row) {
        db.raw.prepare("DELETE FROM sessions WHERE id = ?").run(String(row.session_id));
      }
      throw new HttpError(401, "Session expired", "unauthorized");
    }
    return {
      sessionId: String(row.session_id),
      userId: String(row.user_id),
      email: String(row.email),
      csrfToken: String(row.csrf_token),
    };
  }

  function verifyCsrf(request: Request, auth: AuthContext): void {
    const supplied = request.headers.get("x-csrf-token") ?? "";
    if (!supplied || !timingSafeEqual(supplied, auth.csrfToken)) {
      throw new HttpError(403, "Invalid CSRF token", "invalid_csrf");
    }
  }

  async function createSession(userId: string): Promise<{
    cookie: string;
    csrfToken: string;
  }> {
    const token = randomToken();
    const csrfToken = randomToken();
    const timestamp = now();
    db.raw.prepare(`
      INSERT INTO sessions(id, user_id, token_hash, csrf_token, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      userId,
      await sha256(token),
      csrfToken,
      timestamp + sessionTtlMs,
      timestamp,
    );
    return { cookie: sessionCookie(token), csrfToken };
  }

  async function authRoutes(
    request: Request,
    segments: string[],
  ): Promise<Response | null> {
    if (segments[1] !== "auth") return null;
    const action = segments[2];
    if (request.method === "POST" && action === "register") {
      const body = await readJson(request);
      const email = requiredString(body, "email", 254).toLowerCase();
      const password = requiredSecret(body, "password", 256);
      if (!EMAIL_PATTERN.test(email)) {
        throw new HttpError(400, "Invalid email address", "validation_error");
      }
      if (!rateLimiter.allow(`register:${email}`, now(), 5)) {
        throw new HttpError(429, "Too many attempts", "rate_limited");
      }
      const passwordData = await hashPassword(password);
      const userId = crypto.randomUUID();
      try {
        db.raw.prepare(`
          INSERT INTO users(
            id, email, password_hash, password_salt, password_iterations, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          userId,
          email,
          passwordData.hash,
          passwordData.salt,
          passwordData.iterations,
          now(),
        );
      } catch (error) {
        if (String(error).includes("UNIQUE constraint failed")) {
          throw new HttpError(409, "Email already registered", "email_exists");
        }
        throw error;
      }
      const session = await createSession(userId);
      const user = db.raw.prepare(
        "SELECT id, email, created_at FROM users WHERE id = ?",
      )
        .get(userId) as DbRow;
      return json(
        { user: publicUser(user), csrfToken: session.csrfToken },
        201,
        { "set-cookie": session.cookie },
      );
    }
    if (request.method === "POST" && action === "login") {
      const body = await readJson(request);
      const email = requiredString(body, "email", 254).toLowerCase();
      const password = requiredSecret(body, "password", 256);
      if (!rateLimiter.allow(`login:${email}`, now())) {
        throw new HttpError(429, "Too many attempts", "rate_limited");
      }
      const user = db.raw.prepare("SELECT * FROM users WHERE email = ?").get(email) as
        | DbRow
        | undefined;
      if (
        !user ||
        !await verifyPassword(
          password,
          String(user.password_hash),
          String(user.password_salt),
          Number(user.password_iterations),
        )
      ) {
        throw new HttpError(401, "Invalid email or password", "invalid_credentials");
      }
      const session = await createSession(String(user.id));
      return json(
        { user: publicUser(user), csrfToken: session.csrfToken },
        200,
        { "set-cookie": session.cookie },
      );
    }
    if (
      request.method === "GET" &&
      (action === "me" || action === "session") &&
      segments.length === 3
    ) {
      const auth = await authenticate(request);
      const user = db.raw.prepare(
        "SELECT id, email, created_at FROM users WHERE id = ?",
      )
        .get(auth.userId) as DbRow;
      return json({ user: publicUser(user), csrfToken: auth.csrfToken });
    }
    if (request.method === "POST" && action === "logout") {
      const auth = await authenticate(request);
      verifyCsrf(request, auth);
      db.raw.prepare("DELETE FROM sessions WHERE id = ?").run(auth.sessionId);
      return new Response(null, {
        status: 204,
        headers: { "set-cookie": clearSessionCookie() },
      });
    }
    throw new HttpError(404, "Route not found", "not_found");
  }

  function ownerWishlist(wishlistId: string, ownerId: string): DbRow {
    const row = db.raw.prepare(
      "SELECT * FROM wishlists WHERE id = ? AND owner_id = ?",
    ).get(wishlistId, ownerId) as DbRow | undefined;
    if (!row) throw new HttpError(404, "Wishlist not found", "not_found");
    return row;
  }

  function ownerItem(itemId: string, ownerId: string): DbRow {
    const row = db.raw.prepare(`
      SELECT items.* FROM items
      JOIN wishlists ON wishlists.id = items.wishlist_id
      WHERE items.id = ? AND wishlists.owner_id = ?
    `).get(itemId, ownerId) as DbRow | undefined;
    if (!row) throw new HttpError(404, "Item not found", "not_found");
    return row;
  }

  function parseWishlist(body: JsonObject, partial = false): JsonObject {
    const values: JsonObject = {};
    if (!partial || body.title !== undefined) {
      values.title = requiredString(body, "title", 120);
    }
    const description = optionalString(body, "description", 4_000);
    if (description !== undefined) values.description = description;
    const eventDate = optionalString(body, "eventDate", 10, { nullable: true });
    if (eventDate !== undefined) {
      if (
        eventDate !== null && eventDate !== "" &&
        (
          !/^\d{4}-\d{2}-\d{2}$/.test(eventDate) ||
          Number.isNaN(Date.parse(`${eventDate}T00:00:00Z`)) ||
          new Date(`${eventDate}T00:00:00Z`).toISOString().slice(0, 10) !== eventDate
        )
      ) {
        throw new HttpError(400, "eventDate must use YYYY-MM-DD", "validation_error");
      }
      values.event_date = eventDate || null;
    }
    const published = optionalBoolean(body, "published");
    if (published !== undefined) values.published = published ? 1 : 0;
    return values;
  }

  function parseItem(body: JsonObject, partial = false): JsonObject {
    const values: JsonObject = {};
    if (!partial || body.title !== undefined) {
      values.title = requiredString(body, "title", 200);
    }
    for (
      const [apiKey, dbKey, maxLength] of [
        ["description", "description", 4_000],
        ["note", "note", 2_000],
      ] as const
    ) {
      const value = optionalString(body, apiKey, maxLength);
      if (value !== undefined) values[dbKey] = value;
    }
    for (
      const [apiKey, dbKey] of [
        ["imageUrl", "image_url"],
        ["storeUrl", "store_url"],
      ] as const
    ) {
      const value = optionalUrl(body, apiKey);
      if (value !== undefined) values[dbKey] = value;
    }
    if (body.priority !== undefined) {
      const priority = requiredString(body, "priority", 6);
      if (!["low", "normal", "high"].includes(priority)) {
        throw new HttpError(400, "Invalid priority", "validation_error");
      }
      values.priority = priority;
    }
    const priceCents = optionalInteger(body, "priceCents", 0, 2_147_483_647, true);
    if (priceCents !== undefined) values.price_cents = priceCents;
    if (body.currency !== undefined) {
      const currency = optionalString(body, "currency", 3, { nullable: true });
      if (currency && !CURRENCY_PATTERN.test(currency.toUpperCase())) {
        throw new HttpError(
          400,
          "currency must be a 3-letter code",
          "validation_error",
        );
      }
      values.currency = currency?.toUpperCase() || null;
    }
    const position = optionalInteger(body, "position", 0, 1_000_000);
    if (position !== undefined) values.position = position;
    const archived = optionalBoolean(body, "archived");
    if (archived !== undefined) values.archived = archived ? 1 : 0;
    return values;
  }

  function insertDynamic(
    table: string,
    fixed: JsonObject,
    values: JsonObject,
  ): void {
    const all = { ...fixed, ...values };
    const keys = Object.keys(all);
    db.raw.prepare(
      `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${
        keys.map(() => "?").join(", ")
      })`,
    ).run(...Object.values(all) as (string | number | null)[]);
  }

  function updateDynamic(
    table: string,
    values: JsonObject,
    where: string,
    whereValues: (string | number)[],
  ): void {
    const keys = Object.keys(values);
    if (!keys.length) {
      throw new HttpError(400, "No fields to update", "validation_error");
    }
    db.raw.prepare(
      `UPDATE ${table} SET ${
        keys.map((key) => `${key} = ?`).join(", ")
      } WHERE ${where}`,
    ).run(...Object.values(values) as (string | number | null)[], ...whereValues);
  }

  async function ownerRoutes(
    request: Request,
    segments: string[],
  ): Promise<Response | null> {
    const isWishlist = segments[1] === "wishlists";
    const isItem = segments[1] === "items";
    if (!isWishlist && !isItem) return null;
    const auth = await authenticate(request);
    if (!["GET", "HEAD"].includes(request.method)) verifyCsrf(request, auth);

    if (isWishlist && segments.length === 2 && request.method === "GET") {
      const rows = db.raw.prepare(`
        SELECT
          wishlists.*,
          COUNT(items.id) AS item_count,
          COUNT(items.reserved_at) AS reserved_count
        FROM wishlists
        LEFT JOIN items ON items.wishlist_id = wishlists.id
        WHERE wishlists.owner_id = ?
        GROUP BY wishlists.id
        ORDER BY wishlists.updated_at DESC
      `).all(auth.userId) as DbRow[];
      return json({ wishlists: rows.map(wishlistFromRow) });
    }
    if (isWishlist && segments.length === 2 && request.method === "POST") {
      const body = await readJson(request);
      const values = parseWishlist(body);
      const timestamp = now();
      const id = crypto.randomUUID();
      insertDynamic("wishlists", {
        id,
        owner_id: auth.userId,
        slug: randomToken(9),
        description: "",
        published: 0,
        created_at: timestamp,
        updated_at: timestamp,
      }, values);
      const row = ownerWishlist(id, auth.userId);
      return json({ wishlist: wishlistFromRow(row) }, 201);
    }
    if (isWishlist && segments.length === 3) {
      const id = segments[2];
      if (request.method === "GET") {
        const row = ownerWishlist(id, auth.userId);
        const items = db.raw.prepare(
          "SELECT * FROM items WHERE wishlist_id = ? ORDER BY position, created_at",
        ).all(id) as DbRow[];
        return json({
          wishlist: {
            ...wishlistFromRow(row),
            items: items.map((item) => itemFromRow(item, true)),
          },
        });
      }
      if (request.method === "PATCH") {
        ownerWishlist(id, auth.userId);
        const values = parseWishlist(await readJson(request), true);
        if (!Object.keys(values).length) {
          throw new HttpError(400, "No fields to update", "validation_error");
        }
        values.updated_at = now();
        updateDynamic(
          "wishlists",
          values,
          "id = ? AND owner_id = ?",
          [id, auth.userId],
        );
        return json({ wishlist: wishlistFromRow(ownerWishlist(id, auth.userId)) });
      }
      if (request.method === "DELETE") {
        ownerWishlist(id, auth.userId);
        db.raw.prepare("DELETE FROM wishlists WHERE id = ? AND owner_id = ?").run(
          id,
          auth.userId,
        );
        return new Response(null, { status: 204 });
      }
    }
    if (
      isWishlist && segments.length === 4 && segments[3] === "items" &&
      request.method === "POST"
    ) {
      const wishlistId = segments[2];
      ownerWishlist(wishlistId, auth.userId);
      const values = parseItem(await readJson(request));
      const timestamp = now();
      const id = crypto.randomUUID();
      if (values.position === undefined) {
        const row = db.raw.prepare(
          "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM items WHERE wishlist_id = ?",
        ).get(wishlistId) as DbRow;
        values.position = Number(row.position);
      }
      insertDynamic("items", {
        id,
        wishlist_id: wishlistId,
        description: "",
        priority: "normal",
        note: "",
        archived: 0,
        created_at: timestamp,
        updated_at: timestamp,
      }, values);
      return json({ item: itemFromRow(ownerItem(id, auth.userId), true) }, 201);
    }
    if (
      isWishlist && segments.length === 4 && segments[3] === "reorder" &&
      request.method === "POST"
    ) {
      const wishlistId = segments[2];
      ownerWishlist(wishlistId, auth.userId);
      const body = await readJson(request);
      if (
        !Array.isArray(body.itemIds) ||
        body.itemIds.length > 1_000 ||
        body.itemIds.some((id) => typeof id !== "string")
      ) {
        throw new HttpError(400, "itemIds must be an array of IDs", "validation_error");
      }
      const itemIds = body.itemIds as string[];
      if (new Set(itemIds).size !== itemIds.length) {
        throw new HttpError(400, "itemIds must be unique", "validation_error");
      }
      const count = Number(
        (db.raw.prepare("SELECT COUNT(*) AS count FROM items WHERE wishlist_id = ?")
          .get(wishlistId) as DbRow).count,
      );
      if (itemIds.length !== count) {
        throw new HttpError(400, "itemIds must include every item", "validation_error");
      }
      db.raw.exec("BEGIN IMMEDIATE");
      try {
        const statement = db.raw.prepare(
          "UPDATE items SET position = ?, updated_at = ? WHERE id = ? AND wishlist_id = ?",
        );
        for (const [position, itemId] of itemIds.entries()) {
          const result = statement.run(position, now(), itemId, wishlistId);
          if (result.changes !== 1) {
            throw new HttpError(
              400,
              "itemIds contains unknown item",
              "validation_error",
            );
          }
        }
        db.raw.prepare("UPDATE wishlists SET updated_at = ? WHERE id = ?").run(
          now(),
          wishlistId,
        );
        db.raw.exec("COMMIT");
      } catch (error) {
        db.raw.exec("ROLLBACK");
        throw error;
      }
      return new Response(null, { status: 204 });
    }
    if (isItem && segments.length === 3) {
      const id = segments[2];
      if (request.method === "PATCH") {
        const current = ownerItem(id, auth.userId);
        const values = parseItem(await readJson(request), true);
        if (!Object.keys(values).length) {
          throw new HttpError(400, "No fields to update", "validation_error");
        }
        values.updated_at = now();
        updateDynamic("items", values, "id = ?", [id]);
        db.raw.prepare("UPDATE wishlists SET updated_at = ? WHERE id = ?").run(
          now(),
          String(current.wishlist_id),
        );
        return json({ item: itemFromRow(ownerItem(id, auth.userId), true) });
      }
      if (request.method === "DELETE") {
        const current = ownerItem(id, auth.userId);
        db.raw.prepare("DELETE FROM items WHERE id = ?").run(id);
        db.raw.prepare("UPDATE wishlists SET updated_at = ? WHERE id = ?").run(
          now(),
          String(current.wishlist_id),
        );
        return new Response(null, { status: 204 });
      }
    }
    throw new HttpError(404, "Route not found", "not_found");
  }

  async function cancelReservation(token: string): Promise<Response> {
    if (token.length < 20 || token.length > 200) {
      throw new HttpError(400, "Invalid cancellation token", "validation_error");
    }
    const result = db.raw.prepare(`
      UPDATE items
      SET reserved_at = NULL, reservation_token_hash = NULL, updated_at = ?
      WHERE reservation_token_hash = ?
    `).run(now(), await sha256(token));
    if (result.changes !== 1) {
      throw new HttpError(404, "Reservation not found", "not_found");
    }
    return new Response(null, { status: 204 });
  }

  async function publicRoutes(
    request: Request,
    segments: string[],
  ): Promise<Response | null> {
    if (
      segments[1] === "reservations" && segments[2] === "cancel" &&
      request.method === "POST"
    ) {
      const token = requiredString(await readJson(request), "token", 200, 20);
      return await cancelReservation(token);
    }
    if (segments[1] !== "public") return null;
    const slug = segments[2];
    if (!slug) throw new HttpError(404, "Wishlist not found", "not_found");
    const wishlist = db.raw.prepare(
      "SELECT * FROM wishlists WHERE slug = ?",
    ).get(slug) as DbRow | undefined;
    if (!wishlist) throw new HttpError(404, "Wishlist not found", "not_found");
    if (segments.length === 3 && request.method === "GET") {
      if (!wishlist.published) {
        throw new HttpError(404, "Wishlist not found", "not_found");
      }
      const items = db.raw.prepare(`
        SELECT * FROM items
        WHERE wishlist_id = ? AND archived = 0
        ORDER BY position, created_at
      `).all(String(wishlist.id)) as DbRow[];
      return json({
        wishlist: {
          ...wishlistFromRow(wishlist),
          items: items.map((item) => itemFromRow(item)),
        },
      });
    }
    if (
      segments.length === 6 && segments[3] === "items" &&
      segments[5] === "reserve" && request.method === "POST"
    ) {
      if (!wishlist.published) {
        throw new HttpError(404, "Wishlist not found", "not_found");
      }
      const itemId = segments[4];
      const token = randomToken();
      const result = db.raw.prepare(`
        UPDATE items
        SET reserved_at = ?, reservation_token_hash = ?, updated_at = ?
        WHERE id = ? AND wishlist_id = ? AND archived = 0 AND reserved_at IS NULL
          AND EXISTS (
            SELECT 1 FROM wishlists
            WHERE wishlists.id = items.wishlist_id AND wishlists.published = 1
          )
      `).run(now(), await sha256(token), now(), itemId, String(wishlist.id));
      if (result.changes !== 1) {
        const exists = db.raw.prepare(
          "SELECT 1 AS found FROM items WHERE id = ? AND wishlist_id = ? AND archived = 0",
        ).get(itemId, String(wishlist.id));
        if (!exists) throw new HttpError(404, "Item not found", "not_found");
        throw new HttpError(409, "Item already reserved", "already_reserved");
      }
      return json({ cancellationToken: token, token }, 201);
    }
    if (
      segments.length === 6 && segments[3] === "items" &&
      segments[5] === "cancel" && request.method === "POST"
    ) {
      const body = await readJson(request);
      const token = typeof body.cancellationToken === "string"
        ? body.cancellationToken
        : body.token;
      if (typeof token !== "string") {
        throw new HttpError(400, "cancellationToken is required", "validation_error");
      }
      const result = db.raw.prepare(`
        UPDATE items
        SET reserved_at = NULL, reservation_token_hash = NULL, updated_at = ?
        WHERE id = ? AND wishlist_id = ? AND reservation_token_hash = ?
      `).run(now(), segments[4], String(wishlist.id), await sha256(token));
      if (result.changes !== 1) {
        throw new HttpError(404, "Reservation not found", "not_found");
      }
      return new Response(null, { status: 204 });
    }
    throw new HttpError(404, "Route not found", "not_found");
  }

  async function serveStatic(pathname: string): Promise<Response> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, "Invalid path", "invalid_path");
    }
    if (decoded.includes("\\") || decoded.split("/").includes("..")) {
      throw new HttpError(400, "Invalid path", "invalid_path");
    }
    let relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    if (!relative.includes(".")) relative = "index.html";
    const filePath = `${publicDir.replace(/\/+$/, "")}/${relative}`;
    try {
      const info = await Deno.stat(filePath);
      if (!info.isFile) throw new Deno.errors.NotFound();
      const headers = new Headers({ "content-type": mimeType(filePath) });
      // Assets are not content-hashed; always revalidate so container upgrades do
      // not leave clients running an older frontend against a newer API.
      headers.set("cache-control", "no-cache");
      return new Response(await Deno.readFile(filePath), { headers });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new HttpError(404, "Not found", "not_found");
      }
      throw error;
    }
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (
      (url.pathname === "/healthz" || url.pathname === "/health") &&
      request.method === "GET"
    ) {
      return json({ status: "ok" });
    }
    if (
      (url.pathname === "/readyz" || url.pathname === "/ready") &&
      request.method === "GET"
    ) {
      db.raw.prepare("SELECT 1").get();
      return json({ status: "ready" });
    }
    if (segments[0] === "api") {
      return await authRoutes(request, segments) ??
        await ownerRoutes(request, segments) ??
        await publicRoutes(request, segments) ??
        (() => {
          throw new HttpError(404, "Route not found", "not_found");
        })();
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new HttpError(405, "Method not allowed", "method_not_allowed");
    }
    return await serveStatic(url.pathname);
  }

  const handler = async (request: Request): Promise<Response> => {
    const startedAt = performance.now();
    let response: Response;
    try {
      response = await route(request);
    } catch (error) {
      if (error instanceof HttpError) {
        response = json(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      } else {
        console.error(JSON.stringify({
          level: "error",
          message: "request failed",
          error: error instanceof Error ? error.message : String(error),
        }));
        response = json(
          { error: { code: "internal_error", message: "Internal server error" } },
          500,
        );
      }
    }
    const headers = new Headers(response.headers);
    securityHeaders(headers);
    if (new URL(request.url).pathname.startsWith("/api/")) {
      headers.set("cache-control", "no-store");
    }
    console.log(JSON.stringify({
      level: "info",
      method: request.method,
      path: new URL(request.url).pathname,
      status: response.status,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    }));
    if (request.method === "HEAD") {
      return new Response(null, { status: response.status, headers });
    }
    return new Response(response.body, { status: response.status, headers });
  };

  return { handler, db, close: () => db.close() };
}
