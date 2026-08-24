# Enrich: nearby vendors (open/closed status + logo + rating)

## What changed
`findNearbyVendors` (backs `GET /api/auth/nearby`) previously returned only
`{id, name, brandName, distance}` — no logo, no rating, and no way for a
customer to tell if a vendor is currently open. This was a real gap: the
Flutter vendor cards were rendering generic fallback icons and a static
"New" rating for every single vendor, because the data was never there.

Now returns:
```json
{
  "id": "...",
  "name": "...",
  "brandName": "...",
  "brandLogo": "https://... (falls back to avatarUrl if no brandLogo set)",
  "distanceKm": 2.4,
  "isOpen": true,
  "averageRating": 4.6,
  "reviewCount": 12
}
```

## isOpen logic
Two independent signals, either can close a vendor:
1. `deliveryPreferences.acceptingOrders === false` — manual pause,
   independent of the weekly schedule
2. Today's entry in `operatingHours` (evaluated in the vendor's own
   timezone from `operatingHours.timezone`, default `Africa/Lagos`) not
   being enabled, or the current time falling outside that day's
   open/close window. Overnight windows (open 18:00, close 02:00) are
   handled correctly.

A vendor who's never touched either setting is treated as **open** — same
default behavior as `computeIsLive` uses for products with no schedule
configured, for consistency.

**Note:** while reading this I noticed `updateOperatingHours` (unrelated
existing code, not touched here) only ever writes `order_openAT`/
`order_closeAT` from Monday's hours regardless of which day is being
edited — so those two columns don't reliably reflect "today's hours" for
any day but Monday. This new code doesn't rely on those columns at all
(reads the full `operatingHours` JSON keyed by the actual current day
instead), so it's unaffected, but flagging in case it matters elsewhere.

## Performance
Ratings are fetched with a single batched `groupBy` query across all
nearby vendor IDs, not one query per vendor.

## Deploy steps
1. Replace `src/controllers/vendorControllerMapping.ts` with the version in
   this package.
2. No schema/migration changes — only reads existing columns
   (`brandLogo`, `avatarUrl`, `operatingHours`, `deliveryPreferences`,
   `VendorReview`), nothing new to migrate.
3. Commit, push, redeploy.

No route or request-contract changes — existing callers of `GET
/api/auth/nearby` keep working, they just get richer objects back.
