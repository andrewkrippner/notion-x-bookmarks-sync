# notion-x-bookmarks-sync

Sync your [X](https://x.com) bookmarks into a [Notion](https://www.notion.so) database — automatically, with the author, type, and full post text on every page.

Built as a [Notion Worker](https://developers.notion.com/docs/workers) — no server to run. You deploy it once with the `ntn` CLI and Notion runs it on a schedule.

## What you get

A managed "X Bookmarks" database in your Notion workspace, one row per bookmarked post, with:

| Column | Type | Description |
|---|---|---|
| Tweet | Title | The post text, collapsed to a single line |
| Type | Select | `Post`, `Thread` (a self-reply continuation), or `Article` (a long-form post) |
| Author | Text | `Name (@handle)` |
| URL | URL | Permalink to the post on x.com |
| Posted | Date | When the post was published, in your timezone |
| Tweet ID | Text | X post id (primary key; hide it in your views) |

Each page's icon is the author's avatar, and the page body holds the full post text, any images, and a "View on X" link.

> **Views:** The screenshot's "All" / "Articles" tabs are Notion views you create yourself — e.g. filter by `Type`. The worker owns the data and schema, not the views.

## Heads up: X API access & cost

The bookmarks endpoint (`GET /2/users/:id/bookmarks`) requires OAuth 2.0 user-context auth with the `bookmark.read` scope — it is **not** on the free tier.

Good news on cost: as of 2026 X defaults new developer accounts to **pay-per-use** billing (the old flat **$200/mo Basic** plan is closed to new signups). Bookmarks count as **"owned reads"** at roughly **$0.001 per post**, so:

- A one-time full backlog load of ~800 bookmarks costs **well under $1**.
- Daily incremental runs cost fractions of a cent — most days the worker fetches a single page, sees nothing new, and stops.

If your X developer account predates the switch it may still be on a legacy flat plan; either way this worker fits comfortably in the cheapest option. Rate limits (15-min rolling windows, a 2M-reads/month cap) still apply but are irrelevant at this volume.

## Prerequisites

1. A **Notion API token** from an integration with workspace access (https://www.notion.so/profile/integrations).
2. An **X app** with **OAuth 2.0** enabled — see the step-by-step below.

### Create the X app

1. Go to the [X Developer Portal](https://developer.x.com) and sign in with the X account whose bookmarks you want to sync. Create a **Project** and an **App** inside it if you don't have one (the default pay-per-use access is fine — you do **not** need to buy the Basic plan).
2. In the app's **Settings → User authentication settings**, click **Set up** / **Edit** and configure:
   - **App permissions:** **Read**.
   - **Type of App:** **Web App, Automated App or Bot** (a *confidential* client — this gives you a client secret).
   - **Callback URI / Redirect URL:** `http://localhost:8080/callback` (only used for the one-time local bootstrap).
   - **Website URL:** any URL you own (X requires one).
3. Save, then open **Keys and tokens** and copy your **OAuth 2.0 Client ID** and **Client Secret**. You'll need both below.

## Setup

### 1. Fork & clone

Fork this repo on GitHub, clone your fork, and `pnpm install`.

### 2. Get your X refresh token (one time)

X uses OAuth 2.0 with rotating refresh tokens, so you authorize once locally to
mint the initial token. The worker refreshes and rotates it from there.

```bash
X_CLIENT_ID=your_client_id X_CLIENT_SECRET=your_client_secret pnpm oauth
```

This opens your browser, you approve the `tweet.read users.read bookmark.read
offline.access` scopes, and the script prints your **refresh token**. Keep it handy.

### 3. Bootstrap the worker (one time, local)

A Notion Worker must exist before CI can update it, and CI runners keep no state
between runs — so you create the worker once from your laptop and commit its
`workers.json`:

```bash
pnpm add -g ntn              # install the Notion CLI
ntn login                    # log in to your Notion workspace

rm -f workers.json           # drop any upstream author's worker pointer
pnpm worker:create           # builds + creates your worker; writes workers.json

git add workers.json
git commit -m "Bootstrap my worker"
git push
```

`workers.json` holds only your worker's UUID — it's the routing identifier CI
uses to find the worker on later deploys, not a secret.

### 4. Configure the repo in GitHub

Settings → Secrets and variables → Actions:

| Kind | Name | Value |
|---|---|---|
| Secret | `NOTION_API_TOKEN` | your Notion integration token |
| Secret | `X_CLIENT_ID` | your X OAuth2 client id |
| Secret | `X_CLIENT_SECRET` | your X OAuth2 client secret |
| Secret | `X_REFRESH_TOKEN` | the refresh token from step 2 (bootstrap only) |
| Variable | `TIMEZONE` | e.g. `America/Los_Angeles` (optional) |
| Variable | `SYNC_SCHEDULE` | e.g. `1d`, `6h` (optional, defaults to `1d`) |
| Variable | `X_FULL_LOAD_LIMIT` | cap on the first backlog load (optional, defaults to `800`; `0` = full history) |

Or via `gh`:

```bash
gh secret set NOTION_API_TOKEN
gh secret set X_CLIENT_ID
gh secret set X_CLIENT_SECRET
gh secret set X_REFRESH_TOKEN
gh variable set TIMEZONE --body "America/Los_Angeles"
gh variable set X_FULL_LOAD_LIMIT --body "800"
```

### 5. Push to `master`

CI builds, sets the worker env vars, and deploys. Notion then runs the sync on
your schedule, and the database appears under the integration you authorized.

## How it works

- **Auth:** each run refreshes a short-lived OAuth2 access token from the refresh
  token. X rotates the refresh token on every use, so the worker persists the new
  one in its sync state — `X_REFRESH_TOKEN` is only the one-time bootstrap value.
- **Incremental:** the worker remembers the newest-bookmarked tweet id from the
  last completed cycle and stops paging once it reaches it, so steady-state runs
  are cheap.
- **Paginated:** bookmarks are fetched one page (up to 100) per run cycle; large
  backlogs walk across multiple calls, which keeps each call rate-limit friendly.
  The first backlog load stops after `X_FULL_LOAD_LIMIT` posts (default 800) so an
  enormous history doesn't page forever — set it to `0` to walk everything.
- **Resilient:** transient X `5xx` / network errors on the read endpoints are
  retried with exponential backoff. A failed run leaves the sync state untouched,
  so the next scheduled run simply picks up where it left off.
- **Typed:** each post is tagged `Post`, `Thread` (a self-reply continuation), or
  `Article` (a long-form post), and long-form bodies are stored in full.
- **Upsert by post id:** re-running the sync is safe; rows are keyed on the post
  id and updated in place.

## Useful commands

```bash
pnpm worker:deploy         # rebuild + redeploy the worker
pnpm worker:status         # check sync status
pnpm worker:sync           # force a sync now
pnpm worker:sync:preview   # dry run
pnpm worker:reset          # re-sync all bookmarks from scratch

# Not scripted (run directly):
ntn workers capabilities disable xBookmarksSync  # pause syncing
ntn workers capabilities enable xBookmarksSync   # resume syncing
```

> After a `state reset`, the stored (rotated) refresh token is cleared too, so
> re-set a fresh `X_REFRESH_TOKEN` (repeat step 2) before the next run.

## Development

```bash
pnpm install
pnpm check    # typecheck
pnpm build    # emit dist/
```

The worker entrypoint is `src/index.ts`; the X API client is `src/x.ts`.

## License

[MIT](./LICENSE)
