import { createApp } from "../src/app.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    csrf?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.csrf) headers.set("x-csrf-token", options.csrf);
  return new Request(`http://localhost${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

Deno.test("owner CRUD and public reservation lifecycle", async () => {
  const app = createApp({ databasePath: ":memory:", secureCookies: false });
  try {
    const registration = await app.handler(request("/api/auth/register", {
      method: "POST",
      body: { email: "owner@example.com", password: "correct horse battery staple" },
    }));
    assertEquals(registration.status, 201);
    const auth = await jsonBody(registration);
    const cookie = registration.headers.get("set-cookie")?.split(";")[0];
    const csrf = String(auth.csrfToken);
    assert(cookie);
    assert(csrf.length >= 32);

    const session = await app.handler(
      request("/api/auth/session", { cookie }),
    );
    assertEquals(session.status, 200);
    assertEquals((await jsonBody(session)).csrfToken, csrf);

    const createdList = await app.handler(request("/api/wishlists", {
      method: "POST",
      cookie,
      csrf,
      body: {
        title: "Birthday",
        description: "Ideas",
        eventDate: "2027-01-01",
        published: true,
      },
    }));
    assertEquals(createdList.status, 201);
    const wishlist = (await jsonBody(createdList)).wishlist as Record<string, unknown>;
    const wishlistId = String(wishlist.id);
    const slug = String(wishlist.slug);

    const createdItem = await app.handler(
      request(`/api/wishlists/${wishlistId}/items`, {
        method: "POST",
        cookie,
        csrf,
        body: {
          title: "Coffee grinder",
          description: "Quiet burr grinder",
          priceCents: 12999,
          currency: "usd",
          priority: "high",
          storeUrl: "https://example.com/grinder",
        },
      }),
    );
    assertEquals(createdItem.status, 201);
    const item = (await jsonBody(createdItem)).item as Record<string, unknown>;
    const itemId = String(item.id);
    assertEquals(item.currency, "USD");

    const publicList = await app.handler(request(`/api/public/${slug}`));
    assertEquals(publicList.status, 200);
    const publicWishlist = (await jsonBody(publicList)).wishlist as Record<
      string,
      unknown
    >;
    assertEquals((publicWishlist.items as unknown[]).length, 1);

    const [firstReserve, secondReserve] = await Promise.all([
      app.handler(
        request(`/api/public/${slug}/items/${itemId}/reserve`, { method: "POST" }),
      ),
      app.handler(
        request(`/api/public/${slug}/items/${itemId}/reserve`, { method: "POST" }),
      ),
    ]);
    assertEquals(
      [firstReserve.status, secondReserve.status].sort((a, b) => a - b),
      [201, 409],
    );
    const success = firstReserve.status === 201 ? firstReserve : secondReserve;
    const cancellationToken = String((await jsonBody(success)).cancellationToken);
    assert(cancellationToken.length >= 32);

    const ownerView = await app.handler(
      request(`/api/wishlists/${wishlistId}`, { cookie }),
    );
    const ownerWishlist = (await jsonBody(ownerView)).wishlist as Record<
      string,
      unknown
    >;
    const ownerItem = (ownerWishlist.items as Record<string, unknown>[])[0];
    assertEquals(ownerItem.reserved, true);
    assert(!JSON.stringify(ownerItem).includes(cancellationToken));

    const dashboard = await app.handler(request("/api/wishlists", { cookie }));
    const dashboardLists = (await jsonBody(dashboard)).wishlists as Record<
      string,
      unknown
    >[];
    assertEquals(dashboardLists.length, 1);
    assertEquals(dashboardLists[0].itemCount, 1);
    assertEquals(dashboardLists[0].reservedCount, 1);

    const cancelled = await app.handler(
      request(`/api/public/${slug}/items/${itemId}/cancel`, {
        method: "POST",
        body: { cancellationToken },
      }),
    );
    assertEquals(cancelled.status, 204);

    const dashboardAfterCancel = await app.handler(
      request("/api/wishlists", { cookie }),
    );
    const listAfterCancel = ((await jsonBody(dashboardAfterCancel)).wishlists as Record<
      string,
      unknown
    >[])[0];
    assertEquals(listAfterCancel.itemCount, 1);
    assertEquals(listAfterCancel.reservedCount, 0);

    const updated = await app.handler(request(`/api/items/${itemId}`, {
      method: "PATCH",
      cookie,
      csrf,
      body: { archived: true, title: "Coffee grinder Pro" },
    }));
    assertEquals(updated.status, 200);

    const deleted = await app.handler(request(`/api/items/${itemId}`, {
      method: "DELETE",
      cookie,
      csrf,
    }));
    assertEquals(deleted.status, 204);

    const loggedOut = await app.handler(request("/api/auth/logout", {
      method: "POST",
      cookie,
      csrf,
    }));
    assertEquals(loggedOut.status, 204);
    assert(loggedOut.headers.get("set-cookie")?.includes("Max-Age=0"));
    assertEquals(
      (await app.handler(request("/api/wishlists", { cookie }))).status,
      401,
    );
  } finally {
    app.close();
  }
});

Deno.test("health, readiness, validation, reorder, and global cancel alias", async () => {
  const app = createApp({ databasePath: ":memory:", secureCookies: false });
  try {
    for (const path of ["/health", "/healthz", "/ready", "/readyz"]) {
      assertEquals((await app.handler(request(path))).status, 200);
    }
    const registration = await app.handler(request("/api/auth/register", {
      method: "POST",
      body: { email: "test@example.com", password: "long enough password" },
    }));
    const auth = await jsonBody(registration);
    const cookie = registration.headers.get("set-cookie")!.split(";")[0];
    const csrf = String(auth.csrfToken);
    const listResponse = await app.handler(request("/api/wishlists", {
      method: "POST",
      cookie,
      csrf,
      body: { title: "List", published: true },
    }));
    const list = (await jsonBody(listResponse)).wishlist as Record<string, unknown>;
    const listId = String(list.id);
    const slug = String(list.slug);

    const ids: string[] = [];
    for (const title of ["One", "Two"]) {
      const response = await app.handler(request(`/api/wishlists/${listId}/items`, {
        method: "POST",
        cookie,
        csrf,
        body: { title },
      }));
      ids.push(String(((await jsonBody(response)).item as Record<string, unknown>).id));
    }
    assertEquals(
      (await app.handler(request(`/api/wishlists/${listId}/reorder`, {
        method: "POST",
        cookie,
        csrf,
        body: { itemIds: [...ids].reverse() },
      }))).status,
      204,
    );
    const reordered = await app.handler(
      request(`/api/wishlists/${listId}`, { cookie }),
    );
    const reorderedList = (await jsonBody(reordered)).wishlist as Record<
      string,
      unknown
    >;
    assertEquals(
      (reorderedList.items as Record<string, unknown>[]).map((item) => item.id),
      [...ids].reverse(),
    );

    const invalidUrl = await app.handler(request(`/api/items/${ids[0]}`, {
      method: "PATCH",
      cookie,
      csrf,
      body: { storeUrl: "javascript:alert(1)" },
    }));
    assertEquals(invalidUrl.status, 400);

    const reserve = await app.handler(
      request(`/api/public/${slug}/items/${ids[0]}/reserve`, { method: "POST" }),
    );
    const token = String((await jsonBody(reserve)).token);
    assertEquals(
      (await app.handler(request("/api/reservations/cancel", {
        method: "POST",
        body: { token },
      }))).status,
      204,
    );
  } finally {
    app.close();
  }
});

Deno.test("browser icons are linked and served with correct media types", async () => {
  const app = createApp({
    databasePath: ":memory:",
    publicDir: "public",
    secureCookies: false,
  });
  try {
    const index = await app.handler(request("/"));
    assertEquals(index.status, 200);
    const html = await index.text();
    for (
      const path of [
        "/favicon.ico",
        "/icon.svg",
        "/apple-touch-icon.png",
        "/apple-touch-icon-precomposed.png",
      ]
    ) {
      assert(html.includes(path), `${path} is not linked from index`);
    }

    for (
      const [path, contentType] of [
        ["/favicon.ico", "image/x-icon"],
        ["/icon.svg", "image/svg+xml"],
        ["/apple-touch-icon.png", "image/png"],
        ["/apple-touch-icon-precomposed.png", "image/png"],
      ]
    ) {
      const response = await app.handler(request(path));
      assertEquals(response.status, 200);
      assertEquals(response.headers.get("content-type"), contentType);
      assert((await response.arrayBuffer()).byteLength > 0);
    }
  } finally {
    app.close();
  }
});

Deno.test("gift images are constrained to their media frames", async () => {
  const app = createApp({
    databasePath: ":memory:",
    publicDir: "public",
    secureCookies: false,
  });
  try {
    const response = await app.handler(request("/styles.css"));
    assertEquals(response.status, 200);
    const css = await response.text();
    const rule = css.match(/\.gift-image img\s*\{([^}]*)\}/)?.[1] ?? "";
    for (
      const declaration of [
        "position: absolute",
        "inset: 0",
        "width: 100%",
        "height: 100%",
        "object-fit: cover",
      ]
    ) {
      assert(
        rule.includes(declaration),
        `.gift-image img must include ${declaration}`,
      );
    }
  } finally {
    app.close();
  }
});

Deno.test("date inputs can shrink within mobile forms", async () => {
  const app = createApp({
    databasePath: ":memory:",
    publicDir: "public",
    secureCookies: false,
  });
  try {
    const response = await app.handler(request("/styles.css"));
    assertEquals(response.status, 200);
    const css = await response.text();
    const rule = css.match(/input\[type="date"\]\s*\{([^}]*)\}/)?.[1] ?? "";
    assert(rule.includes("min-width: 0"));
  } finally {
    app.close();
  }
});

Deno.test("dashboard cards expose a stretched editor link", async () => {
  const app = createApp({
    databasePath: ":memory:",
    publicDir: "public",
    secureCookies: false,
  });
  try {
    const scriptResponse = await app.handler(request("/app.js"));
    assertEquals(scriptResponse.status, 200);
    const script = await scriptResponse.text();
    assert(script.includes('class="list-card-link"'));
    assert(script.includes('href="${editorPath}" data-link'));

    const styleResponse = await app.handler(request("/styles.css"));
    assertEquals(styleResponse.status, 200);
    const css = await styleResponse.text();
    const stretchedLink = css.match(/\.list-card-link::after\s*\{([^}]*)\}/)?.[1] ?? "";
    assert(stretchedLink.includes("position: absolute"));
    assert(stretchedLink.includes("inset: 0"));

    const actions = css.match(/\.list-card \.card-actions\s*\{([^}]*)\}/)?.[1] ?? "";
    assert(actions.includes("position: relative"));
    assert(actions.includes("z-index: 1"));
  } finally {
    app.close();
  }
});
