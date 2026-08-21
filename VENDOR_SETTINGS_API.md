# Vendor settings API

All routes below require `Authorization: Bearer <accessToken>` and a vendor role. They are mounted under `/api/vendor/settings`.

## Read settings

`GET /api/vendor/settings` returns the saved `operatingHours`, `deliveryPreferences`, and `serviceAreas` values.

## Save operating hours

`PATCH /api/vendor/settings/operating-hours`

```json
{
  "timezone": "Africa/Lagos",
  "monday": { "enabled": true, "open": "10:00", "close": "22:00" },
  "tuesday": { "enabled": true, "open": "10:00", "close": "22:00" },
  "wednesday": { "enabled": true, "open": "10:00", "close": "22:00" },
  "thursday": { "enabled": true, "open": "10:00", "close": "22:00" },
  "friday": { "enabled": true, "open": "10:00", "close": "22:00" },
  "saturday": { "enabled": true, "open": "10:00", "close": "22:00" },
  "sunday": { "enabled": false, "open": null, "close": null }
}
```

## Save delivery preferences

`PATCH /api/vendor/settings/delivery-preferences`

```json
{
  "acceptingOrders": true,
  "deliveryEnabled": true,
  "deliveryRadiusKm": 20,
  "baseDeliveryFee": 300,
  "preparationTimeMinutes": 30
}
```

## Save service areas

`PUT /api/vendor/settings/service-areas`

```json
{
  "areas": [
    {
      "id": "lekki-phase-1",
      "label": "Lekki Phase 1",
      "city": "Lagos",
      "state": "Lagos",
      "radiusKm": 20,
      "enabled": true
    }
  ]
}
```

## Database migration

Run the migration from the backend project root after installing dependencies and configuring `DATABASE_URL`:

```bash
pnpm install
pnpm prisma generate
pnpm prisma migrate deploy
```

The migration adds nullable JSONB columns to `User`: `operatingHours`, `deliveryPreferences`, and `serviceAreas`. Existing users remain compatible because all three fields are nullable.

The Flutter app calls these endpoints from the vendor store settings page. Start the backend first, confirm the API base URL in the Flutter project, then run `flutter pub get`, `flutter analyze`, `flutter test`, and `flutter run`.
