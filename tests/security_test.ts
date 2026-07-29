import { createApp } from "../src/app.ts";
import { hashPassword, timingSafeEqual, verifyPassword } from "../src/security.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`);
}

async function send(
  app: ReturnType<typeof createApp>,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    csrf?: string;
  } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.csrf) headers.set("x-csrf-token", options.csrf);
  return await app.handler(
    new Request(`http://localhost${path}`, {
      method: options.method ?? "GET",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers,
    }),
  );
}

async function register(
  app: ReturnType<typeof createApp>,
  email: string,
): Promise<{ cookie: string; csrf: string }> {
  const response = await send(app, "/api/auth/register", {
    method: "POST",
    body: { email, password: "a safe password 123" },
  });
  const body = await response.json();
  return {
    cookie: response.headers.get("set-cookie")!.split(";")[0],
    csrf: String(body.csrfToken),
  };
}

Deno.test("password derivation uses salt and verifies safely", async () => {
  const first = await hashPassword("correct horse battery staple");
  const second = await hashPassword("correct horse battery staple");
  assert(first.salt !== second.salt);
  assert(first.hash !== second.hash);
  assert(
    await verifyPassword(
      "correct horse battery staple",
      first.hash,
      first.salt,
      first.iterations,
    ),
  );
  assert(
    !await verifyPassword(
      "wrong password",
      first.hash,
      first.salt,
      first.iterations,
    ),
  );
  assert(timingSafeEqual("same", "same"));
  assert(!timingSafeEqual("same", "different"));
});

Deno.test("CSRF, object ownership, unpublished lists, and secret storage", async () => {
  const app = createApp({ databasePath: ":memory:", secureCookies: false });
  try {
    const owner = await register(app, "owner@example.com");
    const attacker = await register(app, "attacker@example.com");

    const noCsrf = await send(app, "/api/wishlists", {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "Nope" },
    });
    assertEquals(noCsrf.status, 403);

    const create = await send(app, "/api/wishlists", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { title: "Private list" },
    });
    const wishlist = (await create.json()).wishlist as Record<string, unknown>;

    const hidden = await send(app, `/api/public/${wishlist.slug}`);
    assertEquals(hidden.status, 404);

    const attack = await send(app, `/api/wishlists/${wishlist.id}`, {
      method: "PATCH",
      cookie: attacker.cookie,
      csrf: attacker.csrf,
      body: { title: "Stolen" },
    });
    assertEquals(attack.status, 404);

    const ownerRead = await send(app, `/api/wishlists/${wishlist.id}`, {
      cookie: owner.cookie,
    });
    assertEquals(
      ((await ownerRead.json()).wishlist as Record<string, unknown>).title,
      "Private list",
    );

    const sessionRow = app.db.raw.prepare(
      "SELECT token_hash, csrf_token FROM sessions LIMIT 1",
    ).get()!;
    const cookieToken = owner.cookie.slice(owner.cookie.indexOf("=") + 1);
    assert(sessionRow.token_hash !== cookieToken);
    assert(!JSON.stringify(sessionRow).includes(cookieToken));

    const userRow = app.db.raw.prepare(
      "SELECT password_hash, password_salt FROM users WHERE email = ?",
    ).get("owner@example.com")!;
    assert(userRow.password_hash !== "a safe password 123");
    assert(userRow.password_salt);

    const headerResponse = await send(app, "/health");
    assertEquals(headerResponse.headers.get("x-frame-options"), "DENY");
    assertEquals(headerResponse.headers.get("x-content-type-options"), "nosniff");
    assert(
      headerResponse.headers.get("content-security-policy")?.includes(
        "frame-ancestors",
      ),
    );
  } finally {
    app.close();
  }
});
