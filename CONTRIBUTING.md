# Contributing

1. Use Node.js 22 or newer.
2. Run `npm ci`.
3. Create `config/config.json` from `config/config.example.json`.
4. Make focused changes with tests.
5. Run `npm run check` before opening a pull request.

Provider implementations belong in `src/providers` and must return normalized `UsageSnapshot` objects. Authentication data must never be logged or included in notification payloads.
