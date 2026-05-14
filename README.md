# xyz-sync

Trends.nz → GoHighLevel catalogue sync.

Diffs two trends.nz CSV exports (`new.csv` vs `old.csv`), creates new collections in GHL, creates new products, updates changed products, uploads images from the public trends.nz CDN, and notifies you on failure.

## Prereqs

- Node 20+
- Python 3 (used by the existing `diff_csv.py` and `diff_categories.py` — no extra packages)
- A GoHighLevel **Marketplace App** with:
  - Distribution Type: **Sub-Account** (or Agency & Sub-Account)
  - Redirect URL registered: `http://localhost:3000/api/oauth/callback`
  - Scopes enabled:
    - `products.readonly`, `products.write`
    - `products/prices.readonly`, `products/prices.write`
    - `products/collection.readonly`, `products/collection.write`
    - `medias.readonly`, `medias.write`
- Your GHL `Sub-Account ID` (Location ID)

## First-time setup

```bash
npm install
cp .env.example .env
# edit .env — fill in GHL_CLIENT_ID, GHL_CLIENT_SECRET, GHL_LOCATION_ID
# (and SMTP_* if you want email notifications)

npm run oauth-setup
# Opens your browser → you pick the sub-account → tokens saved to ./tokens.json
```

## Daily usage — Web UI (recommended)

```bash
npm run web
# → http://localhost:3001
```

The UI has four sections:

1. **Upload** — pick a CSV from your computer, choose its Month + Year (e.g. May 2026), click Upload. The file is archived as `archive/May_2026.csv`.
2. **Archive** — list of all uploaded CSVs, sorted newest first. Delete any you no longer need.
3. **Run sync** — pick which file is "new" and which is "old", optionally toggle dry-run, hit **Run Sync**.
4. **Live output** — every log line streams in via SSE, with a summary card at the end showing collections added / products created / updated / skipped / failed.

The sync copies the chosen archived files to `new.csv` and `old.csv` at the project root (where the Python diff scripts expect them), runs the diff, then runs the orchestrator.

## Daily usage — CLI

If you prefer the terminal:

```bash
# put latest CSV at ./new.csv and the prior month's at ./old.csv
npm run sync:dry        # shows what WOULD happen — no GHL writes
npm run sync            # the real thing
```

The sync will:
1. Run `diff_csv.py` and `diff_categories.py` to produce `changes.csv` and `category_changes.csv`.
2. Create any missing collections in GHL (skips those that already exist).
3. For each row in `changes.csv`:
   - Pull images from the public trends.nz CDN.
   - Upload images to GHL Medias.
   - Create or update the GHL product + price, mapping all CSV fields.
4. Persist progress in `state.json` for crash-safe resume.
5. Write a run summary to `reports/summary-<runId>.json` and a dead-letter `reports/dead-letter-<runId>.csv` for anything that failed.
6. Email you (if configured) when failures happened.

## Smoke test before the first real run

```bash
npm run smoke-one
```

This:
1. Probes `POST /products/collections` and `POST /medias/upload-file` to verify your OAuth scopes.
2. Picks one NEW product from `changes.csv` and pushes it end-to-end.
3. GETs the product back and verifies the image, media count, and price (amount + currency) all round-trip correctly.

If that passes, you're good for the full sync. **Delete the smoke product manually in the GHL UI when done.**

## Resuming a failed run

The sync is **idempotent** via `state.json`. Re-run `npm run sync` and it will:
- Skip collections already created.
- Skip products whose payload hash hasn't changed since last successful sync.
- Re-upload images that failed (cached ones are reused via SHA256 match).

If `state.json` is lost AND GHL already has products, the sync will **abort** with `OrphanRiskError` rather than risk creating duplicates. You can override with `npm run sync -- --allow-create-without-state`, but be warned: any product whose name has been renamed since the last sync will be re-created and the old one orphaned (you'd then sweep manually).

## Token rotation

OAuth refresh tokens auto-rotate on every refresh. The client refreshes pre-emptively 60 seconds before expiry, and reactively on any 401. New tokens are written atomically to `tokens.json`.

If `tokens.json` is corrupted, deleted, or `invalid_grant` is returned (refresh token revoked at the GHL end), the sync hard-fails with `ReinstallRequiredError`. Just re-run `npm run oauth-setup`.

## What's where

```
.
├── archive/                        # uploaded CSVs, named <Month>_<Year>.csv
│   ├── May_2026.csv
│   └── October_2025.csv
├── new.csv old.csv                 # working copies copied from archive at run time (gitignored)
├── diff_csv.py diff_categories.py  # existing, untouched, invoked from TS
├── changes.csv category_changes.csv # produced by the diff scripts (gitignored)
├── state.json tokens.json          # idempotency + auth (gitignored, mode 0600)
├── logs/                           # one structured-JSON log per run
├── reports/                        # summary + dead-letter per run
└── src/                            # TypeScript implementation
    ├── config.ts logger.ts state.ts
    ├── oauth/                      # OAuth setup, callback server, refresh flow
    ├── ghl/                        # GHL HTTP client + resource modules
    ├── trends/                     # Public CDN fetcher (no auth)
    ├── mapping/                    # CSV row → GHL DTOs
    ├── orchestrator/               # Phase pipeline (collections, images, products)
    ├── reporter.ts notify.ts       # Run summary + email/SMTP
    ├── diff-runner.ts              # Shells out to python3
    ├── smoke.ts cli.ts             # Smoke test + commander entrypoint
    └── web/                        # Express server + UI
        ├── server.ts log-stream.ts
        └── static/                 # index.html, app.js, styles.css
```

## Configuration reference (`.env`)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GHL_CLIENT_ID` | yes | — | OAuth client id from your Marketplace app |
| `GHL_CLIENT_SECRET` | yes | — | OAuth client secret |
| `GHL_REDIRECT_URI` | no | `http://localhost:3000/api/oauth/callback` | must EXACTLY match what's registered in the Marketplace app |
| `GHL_LOCATION_ID` | yes | — | Sub-account ID |
| `GHL_BASE_URL` | no | `https://services.leadconnectorhq.com` | API host |
| `GHL_API_VERSION` | no | `2021-07-28` | only supported value today |
| `GHL_CURRENCY` | no | `USD` | NZD/USD/AUD/GBP/EUR |
| `DATA_DIR` | no | `.` | Where `new.csv`, `old.csv`, `changes.csv` live |
| `STATE_FILE` | no | `./state.json` | Idempotency cache |
| `TOKENS_FILE` | no | `./tokens.json` | OAuth tokens (mode 0600, gitignored) |
| `LOG_DIR` | no | `./logs` | Structured JSON logs per run |
| `REPORT_DIR` | no | `./reports` | Run summaries + dead-letter |
| `NOTIFY_CHANNEL` | no | `none` | `email` / `slack` / `none` |
| `SMTP_HOST` etc. | no¹ | — | Required if `NOTIFY_CHANNEL=email` |
| `SLACK_WEBHOOK_URL` | no¹ | — | Required if `NOTIFY_CHANNEL=slack` |
| `DRY_RUN` | no | `false` | If `true`, no GHL writes |
| `LOG_LEVEL` | no | `info` | trace/debug/info/warn/error |
| `PYTHON_BIN` | no | `python3` | Override if `python3` isn't on PATH |
| `WEB_PORT` | no | `3001` | Port for `npm run web` |

¹ Required only when the corresponding `NOTIFY_CHANNEL` is set.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `OAuth setup failed: invalid redirect_uri` | The redirect URI in `.env` doesn't match what's registered in the Marketplace app | Make them byte-identical, including port and trailing slash |
| `OAuth setup failed: invalid_grant` | Auth code already used, expired, or wrong client secret | Restart `npm run oauth-setup` |
| `Port 3000 is already in use` | Something else is bound to 3000 | Kill it, or change `GHL_REDIRECT_URI` to a free port (and update marketplace settings) |
| Sync aborts with `MissingScopeError` | One of the 8 scopes wasn't granted | Add it to the Marketplace app, re-run `npm run oauth-setup` |
| Sync aborts with `OrphanRiskError` | `state.json` was lost but GHL has products | Either restore `state.json` from a backup, or pass `--allow-create-without-state` accepting the duplicate risk |
| Many products report `image_missing` | Some CDN images are 403/404 (data quality) | Inspect the dead-letter; usually safe to ignore |
| Sync wall-time > 60 minutes | Outbound bandwidth is the bottleneck | Reduce `concurrency` in `src/orchestrator/images.ts` (default 10) or run on a cloud VM |

## Run the tests

```bash
npm test          # 36 unit tests across mapping, OAuth flow, state store
npm run typecheck # tsc --noEmit, strict mode
```
