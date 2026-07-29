# Browser API contract

Frontend uses same-origin JSON under `/api`. All fetches include cookies. Authenticated
mutations send `X-CSRF-Token` from auth response. Errors use a non-2xx status plus
`{"error":"human-readable message"}`.

## Authentication

- `GET /api/auth/me` → `{"user":{"id":"…","email":"…"},"csrfToken":"…"}` or `401`.
- `POST /api/auth/register` with `{"email":"…","password":"…"}` → same shape.
- `POST /api/auth/login` with `{"email":"…","password":"…"}` → same shape.
- `POST /api/auth/logout` → `204` or JSON success.

## Owner wish lists

- `GET /api/wishlists` → `{"wishlists":[WishlistSummary]}`.
- `POST /api/wishlists` with `{title,eventDate,description}` → `{"wishlist": Wishlist}`.
- `GET /api/wishlists/:id` → `{"wishlist": WishlistWithItems}`.
- `PATCH /api/wishlists/:id` with `{title,eventDate,description,published}` →
  `{"wishlist": Wishlist}`.
- `DELETE /api/wishlists/:id` → `204` or JSON success.
- `POST /api/wishlists/:id/items` with `ItemInput` → `{"item": Item}`.
- `PATCH /api/items/:id` with `ItemInput` → `{"item": Item}`.
- `DELETE /api/items/:id` → `204` or JSON success.
- `POST /api/wishlists/:id/reorder` with `{"itemIds":["…"]}` → `204` or JSON success.

`Wishlist` fields: `id`, `slug`, `title`, `description`, `eventDate`, `published`.
Summaries also provide `itemCount` and `reservedCount`.

`ItemInput` fields: `title`, nullable HTTPS `storeUrl`, nullable HTTPS `imageUrl`,
nullable numeric `price`, 3-letter `currency`, `priority` (`low|medium|high`), `note`,
and `archived`.

`Item` adds `id`, `position`, `reserved`, and `createdAt`.

## Public wish lists

- `GET /api/public/:slug` → `{"wishlist": WishlistWithItems}`. Unpublished or unknown
  slugs return `404`.
- `POST /api/public/:slug/items/:id/reserve` with `{}` →
  `{"cancellationToken":"unguessable secret"}`. Atomic conflict returns `409`.
- `POST /api/public/:slug/items/:id/cancel` with `{"token":"…"}` → `204` or JSON
  success.

Cancellation token is kept only in browser local storage. API must not return visitor
identity to list owner.

## Browser routes

- `/` marketing entry.
- `/login` and `/register`.
- `/dashboard` and `/dashboard/:listId`.
- `/w/:publicSlug` public shared list.

Server should return `public/index.html` for browser routes while keeping unknown asset
and API paths as real `404` responses.
