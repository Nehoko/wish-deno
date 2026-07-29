const app = document.querySelector("#app");
const nav = document.querySelector("#site-nav");
const modalRoot = document.querySelector("#modal-root");
const toastRegion = document.querySelector("#toast-region");

const state = {
  user: null,
  csrfToken: "",
  lists: [],
  list: null,
  publicList: null,
  authMode: "login",
  filters: { query: "", availability: "all", sort: "added" },
};

const API = "/api";
const reservationStorageKey = "wish-deno.reservations.v1";

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

function jsonDate(value, options = {}) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    ...options,
  }).format(parsed);
}

function money(value, currency = "USD") {
  if (value === null || value === undefined || value === "") return "";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 2,
    }).format(Number(value));
  } catch {
    return `${currency || ""} ${Number(value).toFixed(2)}`.trim();
  }
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (
    state.csrfToken &&
    options.method &&
    !["GET", "HEAD"].includes(options.method.toUpperCase())
  ) {
    headers.set("X-CSRF-Token", state.csrfToken);
  }

  const response = await fetch(`${API}${path}`, {
    credentials: "same-origin",
    ...options,
    headers,
  });
  const type = response.headers.get("content-type") || "";
  const body = type.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const error = new Error(
      typeof body === "object" && body?.error?.message
        ? body.error.message
        : typeof body === "object" && body?.message
        ? body.message
        : `Request failed (${response.status})`,
    );
    error.status = response.status;
    error.details = body;
    throw error;
  }
  return body;
}

function unwrap(value, key) {
  return value?.[key] ?? value;
}

function normalizeList(raw = {}) {
  return {
    ...raw,
    id: raw.id,
    slug: raw.slug || raw.shareSlug || "",
    title: raw.title || raw.name || "Untitled list",
    description: raw.description || "",
    eventDate: raw.eventDate || raw.event_date || "",
    published: Boolean(raw.published ?? raw.isPublished),
    items: raw.items || [],
    itemCount: raw.itemCount ?? raw.item_count ?? raw.items?.length ?? 0,
    reservedCount: raw.reservedCount ?? raw.reserved_count ??
      raw.items?.filter((item) => item.reserved).length ?? 0,
  };
}

function normalizeItem(raw = {}) {
  return {
    ...raw,
    id: raw.id,
    title: raw.title || raw.name || "Untitled wish",
    imageUrl: raw.imageUrl || raw.image_url || "",
    storeUrl: raw.storeUrl || raw.store_url || raw.url || "",
    note: raw.note || raw.description || "",
    price: raw.price ??
      (raw.priceCents === null || raw.priceCents === undefined
        ? null
        : Number(raw.priceCents) / 100),
    currency: raw.currency || "USD",
    priority: raw.priority || "normal",
    reserved: Boolean(raw.reserved ?? raw.isReserved),
    archived: Boolean(raw.archived ?? raw.isArchived),
    position: raw.position ?? 0,
    createdAt: raw.createdAt || raw.created_at || "",
  };
}

function normalizeListWithItems(raw) {
  const list = normalizeList(raw);
  list.items = (raw?.items || []).map(normalizeItem);
  return list;
}

function route() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const publicMatch = path.match(/^\/(?:w|wishlist)\/([^/]+)$/);
  const editorMatch = path.match(/^\/dashboard\/([^/]+)$/);
  if (publicMatch) return { name: "public", slug: decodeURIComponent(publicMatch[1]) };
  if (editorMatch) return { name: "editor", id: decodeURIComponent(editorMatch[1]) };
  if (path === "/dashboard") return { name: "dashboard" };
  if (path === "/login") return { name: "auth", mode: "login" };
  if (path === "/register") return { name: "auth", mode: "register" };
  return { name: "home" };
}

function navigate(path) {
  history.pushState({}, "", path);
  closeModal();
  renderRoute();
  globalThis.scrollTo({ top: 0, behavior: "smooth" });
}

function setNav() {
  if (state.user) {
    nav.innerHTML = `
      <span class="email">${escapeHtml(state.user.email)}</span>
      <a class="btn btn-small" href="/dashboard" data-link>My lists</a>
      <button class="btn btn-small btn-ghost" type="button" data-action="logout">Sign out</button>
    `;
  } else {
    nav.innerHTML = `
      <a class="btn btn-small btn-ghost" href="/login" data-link>Sign in</a>
      <a class="btn btn-small btn-primary" href="/register" data-link>Make a list</a>
    `;
  }
}

function loading(message = "Loading…") {
  app.innerHTML = `
    <div class="page-state" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

function errorView(title, message, retryPath = location.pathname) {
  app.innerHTML = `
    <section class="shell narrow">
      <div class="empty-state">
        <span class="empty-symbol" aria-hidden="true">!</span>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(message)}</p>
        <div class="actions" style="justify-content:center">
          <button class="btn btn-primary" type="button" data-retry="${
    escapeHtml(retryPath)
  }">Try again</button>
          <a class="btn" href="/" data-link>Go home</a>
        </div>
      </div>
    </section>
  `;
}

function toast(message, kind = "success") {
  const node = document.createElement("div");
  node.className = `toast${kind === "error" ? " toast-error" : ""}`;
  node.textContent = message;
  toastRegion.append(node);
  setTimeout(() => node.remove(), 4200);
}

function formError(form, error) {
  let node = form.querySelector(".form-error");
  if (!node) {
    node = document.createElement("p");
    node.className = "form-error";
    node.setAttribute("role", "alert");
    form.prepend(node);
  }
  node.textContent = error.message || "Something went wrong. Please try again.";
}

function setSubmitting(form, active) {
  const button = form.querySelector('[type="submit"]');
  if (!button) return;
  button.disabled = active;
  if (active) {
    button.dataset.label = button.textContent;
    button.textContent = "Saving…";
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
}

function renderHome() {
  document.title = "Wish Deno — wishes, made simple";
  app.innerHTML = `
    <section class="shell hero">
      <div>
        <p class="eyebrow">Thoughtful gifting, no guesswork</p>
        <h1>Share wishes. Keep surprises.</h1>
        <p class="lede">
          Make a beautiful wish list in minutes. Friends reserve gifts privately,
          so every gift stays special and no one buys the same thing twice.
        </p>
        <div class="actions">
          <a class="btn btn-primary" href="${
    state.user ? "/dashboard" : "/register"
  }" data-link>
            ${
    state.user ? "Open my lists" : "Create your list"
  } <span aria-hidden="true">→</span>
          </a>
          <a class="btn" href="/login" data-link>${
    state.user ? "Manage account" : "I already have one"
  }</a>
        </div>
      </div>
      <div class="hero-art" aria-label="Example wish cards">
        <article class="hero-card">
          <div class="hero-card-visual" aria-hidden="true">☕</div>
          <p>Handmade coffee set</p>
        </article>
        <article class="hero-card">
          <div class="hero-card-visual" aria-hidden="true">⌁</div>
          <p>A weekend by the sea</p>
        </article>
      </div>
    </section>
  `;
}

function renderAuth(mode = "login") {
  if (state.user) {
    navigate("/dashboard");
    return;
  }
  state.authMode = mode;
  const register = mode === "register";
  document.title = `${register ? "Create account" : "Sign in"} — Wish Deno`;
  app.innerHTML = `
    <section class="shell auth-layout">
      <div>
        <p class="eyebrow">${register ? "Start your first list" : "Welcome back"}</p>
        <h1>${register ? "Better gifts begin here." : "Your wishes are waiting."}</h1>
        <p class="lede">
          ${
    register
      ? "One private account for every celebration, milestone, and small delight."
      : "Sign in to add ideas, share lists, and see which wishes are reserved."
  }
        </p>
      </div>
      <div class="auth-card">
        <h2>${register ? "Create account" : "Sign in"}</h2>
        <p class="muted">${
    register
      ? "Use at least 10 characters for your password."
      : "Enter your account details."
  }</p>
        <form id="auth-form" data-mode="${mode}">
          <label class="field">
            <span>Email</span>
            <input name="email" type="email" autocomplete="email" maxlength="254" required autofocus>
          </label>
          <label class="field">
            <span>Password</span>
            <input name="password" type="password" autocomplete="${
    register ? "new-password" : "current-password"
  }"
              minlength="${register ? "10" : "1"}" maxlength="200" required>
          </label>
          <button class="btn btn-primary" type="submit">${
    register ? "Create account" : "Sign in"
  }</button>
        </form>
        <p class="auth-switch">
          ${register ? "Already have an account?" : "New to Wish Deno?"}
          <button class="link-button" type="button" data-auth-mode="${
    register ? "login" : "register"
  }">
            ${register ? "Sign in" : "Create one"}
          </button>
        </p>
      </div>
    </section>
  `;
}

async function loadDashboard() {
  loading("Gathering your lists…");
  try {
    const response = await request("/wishlists");
    state.lists = unwrap(response, "wishlists").map(normalizeList);
    renderDashboard();
  } catch (error) {
    if (error.status === 401) return handleSignedOut();
    errorView("Could not load your lists", error.message);
  }
}

function renderDashboard() {
  document.title = "My lists — Wish Deno";
  const cards = state.lists.map((list) => `
    <article class="list-card">
      <div>
        <span class="badge ${list.published ? "badge-live" : ""}">
          ${list.published ? "Published" : "Private draft"}
        </span>
        <h3>${escapeHtml(list.title)}</h3>
        <p>${escapeHtml(list.description || "A fresh list ready for wishes.")}</p>
        <div class="dashboard-stats">
          <span>${list.itemCount} ${list.itemCount === 1 ? "wish" : "wishes"}</span>
          <span>•</span>
          <span>${list.reservedCount} reserved</span>
        </div>
      </div>
      <div class="card-actions">
        <a class="btn btn-primary btn-small" href="/dashboard/${
    encodeURIComponent(list.id)
  }" data-link>Edit list</a>
        ${
    list.published && list.slug
      ? `<button class="btn btn-small" type="button" data-copy-list="${
        escapeHtml(list.slug)
      }">Copy link</button>`
      : ""
  }
      </div>
    </article>
  `).join("");

  app.innerHTML = `
    <section class="shell">
      <header class="dashboard-head">
        <div>
          <p class="eyebrow">Your space</p>
          <h1>Wish lists</h1>
        </div>
        <button class="btn btn-primary" type="button" data-action="new-list">New list <span aria-hidden="true">＋</span></button>
      </header>
      <div class="list-grid">
        ${
    cards || `
          <div class="empty-state">
            <span class="empty-symbol" aria-hidden="true">✦</span>
            <h2>Your first list starts here</h2>
            <p>Add a birthday, holiday, or collection of someday wishes. Publish only when ready.</p>
            <button class="btn btn-primary" type="button" data-action="new-list">Create a list</button>
          </div>
        `
  }
      </div>
    </section>
  `;
}

async function loadEditor(id) {
  loading("Opening list editor…");
  try {
    const response = await request(`/wishlists/${encodeURIComponent(id)}`);
    state.list = normalizeListWithItems(unwrap(response, "wishlist"));
    renderEditor();
  } catch (error) {
    if (error.status === 401) return handleSignedOut();
    errorView(
      error.status === 404 ? "List not found" : "Could not open this list",
      error.message,
    );
  }
}

function itemRows(items) {
  return items.map((item, index) => {
    const image = safeUrl(item.imageUrl);
    return `
      <article class="item-row">
        <div class="item-thumb">
          ${
      image
        ? `<img src="${escapeHtml(image)}" alt="" loading="lazy">`
        : `<span aria-hidden="true">◇</span>`
    }
        </div>
        <div>
          <h3>${escapeHtml(item.title)}</h3>
          <p>
            ${
      item.price !== null ? escapeHtml(money(item.price, item.currency)) : "No price"
    }
            · ${escapeHtml(item.priority)} priority
            ${item.reserved ? " · Reserved" : ""}
            ${item.archived ? " · Archived" : ""}
          </p>
        </div>
        <div class="row-actions" aria-label="Actions for ${escapeHtml(item.title)}">
          <button class="icon-btn" type="button" title="Move up" aria-label="Move up"
            data-move-item="${escapeHtml(item.id)}" data-direction="up" ${
      index === 0 ? "disabled" : ""
    }>↑</button>
          <button class="icon-btn" type="button" title="Move down" aria-label="Move down"
            data-move-item="${escapeHtml(item.id)}" data-direction="down" ${
      index === items.length - 1 ? "disabled" : ""
    }>↓</button>
          <button class="icon-btn" type="button" title="Edit wish" aria-label="Edit wish"
            data-edit-item="${escapeHtml(item.id)}">✎</button>
          <button class="icon-btn" type="button" title="Delete wish" aria-label="Delete wish"
            data-delete-item="${escapeHtml(item.id)}">×</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderEditor() {
  const list = state.list;
  document.title = `${list.title} — Wish Deno`;
  app.innerHTML = `
    <section class="shell">
      <header class="editor-head">
        <div>
          <a href="/dashboard" data-link class="muted">← All lists</a>
          <p class="eyebrow" style="margin-top:1rem">${
    list.published ? "Published list" : "Private draft"
  }</p>
          <h1>${escapeHtml(list.title)}</h1>
        </div>
        <div class="actions">
          ${
    list.published && list.slug
      ? `<a class="btn" href="/w/${
        encodeURIComponent(list.slug)
      }" data-link>View public list</a>
              <button class="btn" type="button" data-copy-list="${
        escapeHtml(list.slug)
      }">Copy share link</button>`
      : ""
  }
          <button class="btn btn-danger" type="button" data-action="delete-list">Delete</button>
        </div>
      </header>

      <div class="editor-layout">
        <aside class="panel" aria-label="List settings">
          <h2>List details</h2>
          <form id="list-form">
            <label class="field">
              <span>Title</span>
              <input name="title" value="${
    escapeHtml(list.title)
  }" maxlength="120" required>
            </label>
            <label class="field">
              <span>Event date <span class="muted">(optional)</span></span>
              <input name="eventDate" type="date" value="${
    escapeHtml(list.eventDate?.slice(0, 10) || "")
  }">
            </label>
            <label class="field">
              <span>Description <span class="muted">(optional)</span></span>
              <textarea name="description" maxlength="2000">${
    escapeHtml(list.description)
  }</textarea>
            </label>
            <label class="checkbox-field">
              <input name="published" type="checkbox" ${
    list.published ? "checked" : ""
  }>
              <span>Publish this list</span>
            </label>
            <p class="field-hint">Unpublished lists stay visible only to you.</p>
            <button class="btn btn-primary" type="submit">Save details</button>
          </form>
        </aside>

        <section class="panel">
          <header class="section-head">
            <div>
              <p class="eyebrow">Gift ideas</p>
              <h2>${list.items.length} ${
    list.items.length === 1 ? "wish" : "wishes"
  }</h2>
            </div>
            <button class="btn btn-pink" type="button" data-action="new-item">Add wish ＋</button>
          </header>
          <div class="item-list">
            ${
    itemRows(list.items) || `
              <div class="empty-state">
                <span class="empty-symbol" aria-hidden="true">◇</span>
                <h3>No wishes yet</h3>
                <p>Add links, prices, pictures, and notes. You can reorder them anytime.</p>
                <button class="btn btn-primary" type="button" data-action="new-item">Add first wish</button>
              </div>
            `
  }
          </div>
        </section>
      </div>
    </section>
  `;
}

function openListModal() {
  openModal(`
    <div class="modal-head">
      <div><p class="eyebrow">New collection</p><h2>Create a wish list</h2></div>
      <button class="icon-btn" type="button" data-close-modal aria-label="Close">×</button>
    </div>
    <form id="new-list-form">
      <label class="field">
        <span>Title</span>
        <input name="title" maxlength="120" placeholder="Birthday wishes" required autofocus>
      </label>
      <label class="field">
        <span>Event date <span class="muted">(optional)</span></span>
        <input name="eventDate" type="date">
      </label>
      <label class="field">
        <span>Description <span class="muted">(optional)</span></span>
        <textarea name="description" maxlength="2000" placeholder="A little note for friends and family"></textarea>
      </label>
      <div class="actions">
        <button class="btn btn-primary" type="submit">Create list</button>
        <button class="btn btn-ghost" type="button" data-close-modal>Cancel</button>
      </div>
    </form>
  `);
}

function openItemModal(item = null) {
  openModal(`
    <div class="modal-head">
      <div>
        <p class="eyebrow">${item ? "Update idea" : "New idea"}</p>
        <h2>${item ? "Edit wish" : "Add a wish"}</h2>
      </div>
      <button class="icon-btn" type="button" data-close-modal aria-label="Close">×</button>
    </div>
    <form id="item-form" data-item-id="${escapeHtml(item?.id || "")}">
      <div class="form-grid">
        <label class="field wide">
          <span>Wish title</span>
          <input name="title" value="${
    escapeHtml(item?.title || "")
  }" maxlength="160" required autofocus>
        </label>
        <label class="field wide">
          <span>Store link <span class="muted">(optional)</span></span>
          <input name="storeUrl" type="url" value="${escapeHtml(item?.storeUrl || "")}"
            placeholder="https://…" maxlength="2000">
        </label>
        <label class="field wide">
          <span>Image link <span class="muted">(optional)</span></span>
          <input name="imageUrl" type="url" value="${escapeHtml(item?.imageUrl || "")}"
            placeholder="https://…" maxlength="2000">
        </label>
        <label class="field">
          <span>Price <span class="muted">(optional)</span></span>
          <input name="price" type="number" min="0" max="100000000" step="0.01"
            value="${escapeHtml(item?.price ?? "")}">
        </label>
        <label class="field">
          <span>Currency</span>
          <input name="currency" value="${escapeHtml(item?.currency || "USD")}"
            minlength="3" maxlength="3" pattern="[A-Za-z]{3}" required>
        </label>
        <label class="field">
          <span>Priority</span>
          <select name="priority">
            ${
    [["low", "Low"], ["normal", "Medium"], ["high", "High"]].map((
      [priority, label],
    ) =>
      `<option value="${priority}" ${
        item?.priority === priority ? "selected" : ""
      }>${label}</option>`
    ).join("")
  }
          </select>
        </label>
        <label class="checkbox-field">
          <input name="archived" type="checkbox" ${item?.archived ? "checked" : ""}>
          <span>Archive wish</span>
        </label>
        <label class="field wide">
          <span>Note <span class="muted">(optional)</span></span>
          <textarea name="note" maxlength="2000" placeholder="Size, colour, or anything helpful">${
    escapeHtml(item?.note || "")
  }</textarea>
        </label>
      </div>
      <div class="actions">
        <button class="btn btn-primary" type="submit">${
    item ? "Save changes" : "Add wish"
  }</button>
        <button class="btn btn-ghost" type="button" data-close-modal>Cancel</button>
      </div>
    </form>
  `);
}

function openModal(contents) {
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <section class="modal" role="dialog" aria-modal="true">
        ${contents}
      </section>
    </div>
  `;
  document.body.style.overflow = "hidden";
  requestAnimationFrame(() =>
    modalRoot.querySelector("[autofocus], button, input")?.focus()
  );
}

function closeModal() {
  modalRoot.innerHTML = "";
  document.body.style.overflow = "";
}

function getReservations() {
  try {
    return JSON.parse(localStorage.getItem(reservationStorageKey) || "{}");
  } catch {
    return {};
  }
}

function setReservation(slug, itemId, token) {
  const reservations = getReservations();
  const key = `${slug}:${itemId}`;
  if (token) reservations[key] = token;
  else delete reservations[key];
  localStorage.setItem(reservationStorageKey, JSON.stringify(reservations));
}

function reservationFor(slug, itemId) {
  return getReservations()[`${slug}:${itemId}`] || "";
}

async function loadPublicList(slug) {
  loading("Unwrapping this wish list…");
  try {
    const response = await request(`/public/${encodeURIComponent(slug)}`);
    state.publicList = normalizeListWithItems(unwrap(response, "wishlist"));
    state.publicList.slug ||= slug;
    renderPublicList();
  } catch (error) {
    errorView(
      error.status === 404 ? "This list is not available" : "Could not load this list",
      error.status === 404
        ? "It may be private, removed, or the link may be incomplete."
        : error.message,
    );
  }
}

function filteredPublicItems() {
  const { query, availability, sort } = state.filters;
  const items = state.publicList.items.filter((item) => {
    if (item.archived) return false;
    const matchesQuery = !query ||
      `${item.title} ${item.note}`.toLocaleLowerCase().includes(
        query.toLocaleLowerCase(),
      );
    const own = reservationFor(state.publicList.slug, item.id);
    const matchesAvailability = availability === "all" ||
      (availability === "available" && !item.reserved) ||
      (availability === "reserved" && item.reserved) ||
      (availability === "mine" && own);
    return matchesQuery && matchesAvailability;
  });

  return items.toSorted((a, b) => {
    if (sort === "price-low") return (a.price ?? Infinity) - (b.price ?? Infinity);
    if (sort === "price-high") return (b.price ?? -1) - (a.price ?? -1);
    if (sort === "priority") {
      return ({ high: 0, normal: 1, low: 2 }[a.priority] ?? 3) -
        ({ high: 0, normal: 1, low: 2 }[b.priority] ?? 3);
    }
    return (b.position ?? 0) - (a.position ?? 0) ||
      String(b.createdAt).localeCompare(String(a.createdAt));
  });
}

function giftCards(items) {
  const slug = state.publicList.slug;
  return items.map((item) => {
    const image = safeUrl(item.imageUrl);
    const store = safeUrl(item.storeUrl);
    const ownToken = reservationFor(slug, item.id);
    return `
      <article class="gift-card ${ownToken ? "reserved-own" : ""}">
        <div class="gift-image">
          ${
      image
        ? `<img src="${escapeHtml(image)}" alt="" loading="lazy">`
        : `<span aria-hidden="true">◇</span>`
    }
          ${
      item.reserved
        ? `<span class="badge badge-reserved">${
          ownToken ? "Reserved by you" : "Reserved"
        }</span>`
        : ""
    }
        </div>
        <div class="gift-content">
          <div class="gift-labels">
            ${
      item.price !== null
        ? `<span class="price">${escapeHtml(money(item.price, item.currency))}</span>`
        : ""
    }
            <span class="priority">${escapeHtml(item.priority)} priority</span>
          </div>
          <h2>${escapeHtml(item.title)}</h2>
          ${item.note ? `<p class="note">${escapeHtml(item.note)}</p>` : ""}
          <div class="card-actions">
            ${
      ownToken
        ? `<button class="btn btn-small" type="button" data-cancel-item="${
          escapeHtml(item.id)
        }">Cancel my reservation</button>`
        : item.reserved
        ? `<button class="btn btn-small" type="button" disabled>Already reserved</button>`
        : `<button class="btn btn-pink btn-small" type="button" data-reserve-item="${
          escapeHtml(item.id)
        }">Reserve privately</button>`
    }
            ${
      store
        ? `<a class="store-link" href="${
          escapeHtml(store)
        }" target="_blank" rel="noopener noreferrer">View store ↗</a>`
        : ""
    }
          </div>
        </div>
      </article>
    `;
  }).join("");
}

function renderPublicList() {
  const list = state.publicList;
  const items = filteredPublicItems();
  document.title = `${list.title} — Wish Deno`;
  app.innerHTML = `
    <section class="public-shell">
      <header class="public-head">
        <div>
          <p class="eyebrow">A wish list from someone special</p>
          <h1>${escapeHtml(list.title)}</h1>
          ${
    list.description
      ? `<p class="public-description">${escapeHtml(list.description)}</p>`
      : ""
  }
          <div class="public-meta">
            ${
    list.eventDate ? `<span>◷ ${escapeHtml(jsonDate(list.eventDate))}</span>` : ""
  }
            <span>◇ ${list.items.filter((item) => !item.archived).length} wishes</span>
          </div>
        </div>
        <aside class="privacy-note">
          <strong>Reservations stay private.</strong><br>
          List owner sees that a wish is taken, never who reserved it.
          Cancellation key stays only in this browser.
        </aside>
      </header>

      <div class="filter-bar" aria-label="Filter wishes">
        <label class="search-wrap">
          <span aria-hidden="true">⌕</span>
          <input id="wish-search" type="search" value="${
    escapeHtml(state.filters.query)
  }"
            placeholder="Search wishes" aria-label="Search wishes">
        </label>
        <label>
          <span class="field-label">Availability</span>
          <select id="availability-filter">
            <option value="all" ${
    state.filters.availability === "all" ? "selected" : ""
  }>All wishes</option>
            <option value="available" ${
    state.filters.availability === "available" ? "selected" : ""
  }>Available</option>
            <option value="reserved" ${
    state.filters.availability === "reserved" ? "selected" : ""
  }>Reserved</option>
            <option value="mine" ${
    state.filters.availability === "mine" ? "selected" : ""
  }>Reserved by me</option>
          </select>
        </label>
        <label>
          <span class="field-label">Sort</span>
          <select id="sort-filter">
            <option value="added" ${
    state.filters.sort === "added" ? "selected" : ""
  }>Recently added</option>
            <option value="priority" ${
    state.filters.sort === "priority" ? "selected" : ""
  }>Priority</option>
            <option value="price-low" ${
    state.filters.sort === "price-low" ? "selected" : ""
  }>Price: low first</option>
            <option value="price-high" ${
    state.filters.sort === "price-high" ? "selected" : ""
  }>Price: high first</option>
          </select>
        </label>
      </div>

      <div class="gift-grid" id="gift-grid">
        ${
    giftCards(items) || `
          <div class="empty-state">
            <span class="empty-symbol" aria-hidden="true">⌕</span>
            <h2>No wishes match</h2>
            <p>Try another search or show all availability.</p>
            <button class="btn" type="button" data-action="clear-filters">Clear filters</button>
          </div>
        `
  }
      </div>
    </section>
  `;
}

function renderPublicResults() {
  const grid = document.querySelector("#gift-grid");
  if (!grid) return;
  const items = filteredPublicItems();
  grid.innerHTML = giftCards(items) || `
    <div class="empty-state">
      <span class="empty-symbol" aria-hidden="true">⌕</span>
      <h2>No wishes match</h2>
      <p>Try another search or show all availability.</p>
      <button class="btn" type="button" data-action="clear-filters">Clear filters</button>
    </div>
  `;
}

async function renderRoute() {
  setNav();
  const current = route();
  if (current.name === "public") return await loadPublicList(current.slug);
  if (current.name === "auth") return renderAuth(current.mode);
  if (current.name === "dashboard") {
    if (!state.user) return renderAuth("login");
    return await loadDashboard();
  }
  if (current.name === "editor") {
    if (!state.user) return renderAuth("login");
    return await loadEditor(current.id);
  }
  renderHome();
}

async function loadSession() {
  try {
    const response = await request("/auth/me");
    state.user = response.user ?? (response.email ? response : null);
    state.csrfToken = response.csrfToken || response.csrf_token || "";
  } catch (error) {
    if (error.status !== 401) console.warn("Session check failed", error);
    state.user = null;
    state.csrfToken = "";
  }
}

function handleSignedOut() {
  state.user = null;
  state.csrfToken = "";
  setNav();
  toast("Your session ended. Please sign in again.", "error");
  renderAuth("login");
  history.replaceState({}, "", "/login");
}

async function handleAuth(form) {
  setSubmitting(form, true);
  try {
    const data = new FormData(form);
    const mode = form.dataset.mode;
    const response = await request(`/auth/${mode}`, {
      method: "POST",
      body: JSON.stringify({
        email: data.get("email"),
        password: data.get("password"),
      }),
    });
    state.user = response.user ?? { email: data.get("email") };
    state.csrfToken = response.csrfToken || response.csrf_token || "";
    toast(mode === "register" ? "Account created." : "Welcome back.");
    navigate("/dashboard");
  } catch (error) {
    formError(form, error);
    setSubmitting(form, false);
  }
}

async function handleCreateList(form) {
  setSubmitting(form, true);
  try {
    const data = new FormData(form);
    const response = await request("/wishlists", {
      method: "POST",
      body: JSON.stringify({
        title: data.get("title"),
        eventDate: data.get("eventDate") || null,
        description: data.get("description") || "",
      }),
    });
    const list = normalizeList(unwrap(response, "wishlist"));
    closeModal();
    toast("List created.");
    navigate(`/dashboard/${encodeURIComponent(list.id)}`);
  } catch (error) {
    formError(form, error);
    setSubmitting(form, false);
  }
}

async function handleListUpdate(form) {
  setSubmitting(form, true);
  try {
    const data = new FormData(form);
    const response = await request(`/wishlists/${encodeURIComponent(state.list.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: data.get("title"),
        eventDate: data.get("eventDate") || null,
        description: data.get("description") || "",
        published: data.get("published") === "on",
      }),
    });
    const updated = normalizeList(unwrap(response, "wishlist"));
    state.list = { ...state.list, ...updated, items: state.list.items };
    toast("List details saved.");
    renderEditor();
  } catch (error) {
    formError(form, error);
    setSubmitting(form, false);
  }
}

async function handleItemSave(form) {
  setSubmitting(form, true);
  try {
    const data = new FormData(form);
    const itemId = form.dataset.itemId;
    const payload = {
      title: data.get("title"),
      storeUrl: data.get("storeUrl") || null,
      imageUrl: data.get("imageUrl") || null,
      priceCents: data.get("price") === ""
        ? null
        : Math.round(Number(data.get("price")) * 100),
      currency: String(data.get("currency")).toUpperCase(),
      priority: data.get("priority"),
      archived: data.get("archived") === "on",
      note: data.get("note") || "",
    };
    const response = await request(
      itemId
        ? `/items/${encodeURIComponent(itemId)}`
        : `/wishlists/${encodeURIComponent(state.list.id)}/items`,
      { method: itemId ? "PATCH" : "POST", body: JSON.stringify(payload) },
    );
    const saved = normalizeItem(unwrap(response, "item"));
    if (itemId) {
      state.list.items = state.list.items.map((item) =>
        item.id === itemId ? saved : item
      );
    } else {
      state.list.items.push(saved);
    }
    closeModal();
    toast(itemId ? "Wish updated." : "Wish added.");
    renderEditor();
  } catch (error) {
    formError(form, error);
    setSubmitting(form, false);
  }
}

async function deleteList() {
  if (
    !confirm(`Delete “${state.list.title}” and all its wishes? This cannot be undone.`)
  ) return;
  try {
    await request(`/wishlists/${encodeURIComponent(state.list.id)}`, {
      method: "DELETE",
    });
    toast("List deleted.");
    navigate("/dashboard");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteItem(itemId) {
  const item = state.list.items.find((candidate) =>
    String(candidate.id) === String(itemId)
  );
  if (!item || !confirm(`Delete “${item.title}”? This cannot be undone.`)) return;
  try {
    await request(`/items/${encodeURIComponent(itemId)}`, { method: "DELETE" });
    state.list.items = state.list.items.filter((candidate) =>
      String(candidate.id) !== String(itemId)
    );
    toast("Wish deleted.");
    renderEditor();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function moveItem(itemId, direction) {
  const current = state.list.items.findIndex((item) =>
    String(item.id) === String(itemId)
  );
  const destination = direction === "up" ? current - 1 : current + 1;
  if (current < 0 || destination < 0 || destination >= state.list.items.length) return;
  const before = [...state.list.items];
  [state.list.items[current], state.list.items[destination]] = [
    state.list.items[destination],
    state.list.items[current],
  ];
  renderEditor();
  try {
    await request(`/wishlists/${encodeURIComponent(state.list.id)}/reorder`, {
      method: "POST",
      body: JSON.stringify({ itemIds: state.list.items.map((item) => item.id) }),
    });
    toast("Wish order saved.");
  } catch (error) {
    state.list.items = before;
    renderEditor();
    toast(error.message, "error");
  }
}

async function reserveItem(itemId) {
  const button = document.querySelector(
    `[data-reserve-item="${CSS.escape(String(itemId))}"]`,
  );
  if (button) {
    button.disabled = true;
    button.textContent = "Reserving…";
  }
  try {
    const response = await request(
      `/public/${encodeURIComponent(state.publicList.slug)}/items/${
        encodeURIComponent(itemId)
      }/reserve`,
      { method: "POST", body: JSON.stringify({}) },
    );
    const token = response.cancellationToken || response.token;
    if (!token) {
      throw new Error("Reservation succeeded but no cancellation key was returned.");
    }
    setReservation(state.publicList.slug, itemId, token);
    state.publicList.items = state.publicList.items.map((item) =>
      String(item.id) === String(itemId) ? { ...item, reserved: true } : item
    );
    toast("Reserved. Cancellation key saved in this browser.");
    renderPublicList();
  } catch (error) {
    toast(
      error.status === 409 ? "Someone reserved this wish moments ago." : error.message,
      "error",
    );
    await loadPublicList(state.publicList.slug);
  }
}

async function cancelReservation(itemId) {
  const token = reservationFor(state.publicList.slug, itemId);
  if (!token) {
    toast("Cancellation key not found in this browser.", "error");
    return;
  }
  try {
    await request(
      `/public/${encodeURIComponent(state.publicList.slug)}/items/${
        encodeURIComponent(itemId)
      }/cancel`,
      { method: "POST", body: JSON.stringify({ token }) },
    );
    setReservation(state.publicList.slug, itemId, "");
    state.publicList.items = state.publicList.items.map((item) =>
      String(item.id) === String(itemId) ? { ...item, reserved: false } : item
    );
    toast("Reservation cancelled.");
    renderPublicList();
  } catch (error) {
    toast(error.message, "error");
  }
}

document.addEventListener("click", async (event) => {
  const link = event.target.closest("a[data-link]");
  if (link && link.origin === location.origin) {
    event.preventDefault();
    navigate(link.pathname);
    return;
  }

  const actionNode = event.target.closest("[data-action]");
  const action = actionNode?.dataset.action;
  if (action === "new-list") openListModal();
  if (action === "new-item") openItemModal();
  if (action === "delete-list") await deleteList();
  if (action === "clear-filters") {
    state.filters = { query: "", availability: "all", sort: "added" };
    renderPublicList();
  }
  if (action === "logout") {
    try {
      await request("/auth/logout", { method: "POST", body: JSON.stringify({}) });
    } catch (error) {
      if (error.status !== 401) toast(error.message, "error");
    }
    state.user = null;
    state.csrfToken = "";
    toast("Signed out.");
    navigate("/");
  }

  const authMode = event.target.closest("[data-auth-mode]")?.dataset.authMode;
  if (authMode) navigate(`/${authMode}`);

  const copySlug = event.target.closest("[data-copy-list]")?.dataset.copyList;
  if (copySlug) {
    const shareUrl =
      new URL(`/w/${encodeURIComponent(copySlug)}`, location.origin).href;
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast("Share link copied.");
    } catch {
      globalThis.prompt("Copy this share link:", shareUrl);
    }
  }

  const editId = event.target.closest("[data-edit-item]")?.dataset.editItem;
  if (editId) {
    const item = state.list.items.find((candidate) =>
      String(candidate.id) === String(editId)
    );
    if (item) openItemModal(item);
  }

  const deleteId = event.target.closest("[data-delete-item]")?.dataset.deleteItem;
  if (deleteId) await deleteItem(deleteId);

  const moveNode = event.target.closest("[data-move-item]");
  if (moveNode) await moveItem(moveNode.dataset.moveItem, moveNode.dataset.direction);

  const reserveId = event.target.closest("[data-reserve-item]")?.dataset.reserveItem;
  if (reserveId) await reserveItem(reserveId);

  const cancelId = event.target.closest("[data-cancel-item]")?.dataset.cancelItem;
  if (cancelId) await cancelReservation(cancelId);

  if (
    event.target.matches("[data-close-modal]") ||
    event.target.matches("[data-modal-backdrop]")
  ) {
    closeModal();
  }

  const retry = event.target.closest("[data-retry]")?.dataset.retry;
  if (retry) await renderRoute();
});

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.id === "auth-form") await handleAuth(form);
  if (form.id === "new-list-form") await handleCreateList(form);
  if (form.id === "list-form") await handleListUpdate(form);
  if (form.id === "item-form") await handleItemSave(form);
});

document.addEventListener("input", (event) => {
  if (event.target.id === "wish-search") {
    state.filters.query = event.target.value;
    renderPublicResults();
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "availability-filter") {
    state.filters.availability = event.target.value;
    renderPublicResults();
  }
  if (event.target.id === "sort-filter") {
    state.filters.sort = event.target.value;
    renderPublicResults();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && modalRoot.firstChild) closeModal();
});

globalThis.addEventListener("popstate", renderRoute);

await loadSession();
await renderRoute();
