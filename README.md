# notion-x-bookmarks-sync

Sync your [X (Twitter)](https://x.com) bookmarks into a [Notion](https://www.notion.so) database — automatically, with the author, type, and full tweet text on every page.

Built as a [Notion Worker](https://developers.notion.com/docs/workers) — no server to run. You deploy it once with the `ntn` CLI and Notion runs it on a schedule.

## What you get

A managed "Twitter Bookmarks" database in your Notion workspace, one row per bookmarked tweet, with:

| Column | Type | Description |
|---|---|---|
| Tweet | Title | The tweet text, collapsed to a single line |
| Type | Select | `Post` or `Thread` (a self-reply continuation) |
| Author | Text | `Name (@handle)` |
| URL | URL | Permalink to the tweet on x.com |
| Posted | Date | When the tweet was posted, in your timezone |
| Tweet ID | Text | X tweet id (primary key; hide it in your views) |

Each page's icon is the author's avatar, and the page body holds the full tweet text, any images, and a "View on X" link.

> **Views:** The screenshot's "All" / "Articles" tabs are Notion views you create yourself — e.g. filter by `Type`. The worker owns the data and schema, not the views.

## Heads up: X API access tier

The X bookmarks endpoint (`GET /2/users/:id/bookmarks`) is **not on the free tier** — it requires OAuth 2.0 user-context auth and at least the **Basic** X API plan. You'll need a paid X developer subscription for this to run. Everything below assumes you have one.

## Prerequisites

1. A **Notion API token** from an integration with workspace access (https://www.notion.so/profile/integrations).
2. An **X app** (https://developer.x.com) on the Basic tier (or higher) with **OAuth 2.0** enabled:
   - Type of App: **Web App / Confidential client** (gives you a client secret).
   - App permissions: **Read**.
   - Callback URI: `http://localhost:8080/callback` (for the one-time bootstrap).
   - Note your **Client ID** and **Client Secret**.

## Setup

### 1. Fork & clone

Fork this repo on GitHub, clone your fork, and `npm install`.

### 2. Get your X refresh token (one time)

X uses OAuth 2.0 with rotating refresh tokens, so you authorize once locally to
mint the initial token. The worker refreshes and rotates it from there.

```bash
X_CLIENT_ID=your_client_id X_CLIENT_SECRET=your_client_secret npm run oauth
```

This opens your browser, you approve the `tweet.read users.read bookmark.read
offline.access` scopes, and the script prints your **refresh token**. Keep it handy.

### 3. Bootstrap the worker (one time, local)

A Notion Worker must exist before CI can update it, and CI runners keep no state
between runs — so you create the worker once from your laptop and commit its
`workers.json`:

```bash
npm i -g ntn                 # install the Notion CLI
ntn login                    # log in to your Notion workspace

rm -f workers.json           # drop any upstream author's worker pointer
ntn workers deploy --name notion-x-bookmarks-sync   # creates your worker; writes workers.json

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

Or via `gh`:

```bash
gh secret set NOTION_API_TOKEN
gh secret set X_CLIENT_ID
gh secret set X_CLIENT_SECRET
gh secret set X_REFRESH_TOKEN
gh variable set TIMEZONE --body "America/Los_Angeles"
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
- **Upsert by tweet id:** re-running the sync is safe; rows are keyed on the tweet
  id and updated in place.

## Useful commands

```bash
ntn workers sync status                          # Check sync status
ntn workers sync trigger xBookmarksSync          # Force a sync now
ntn workers sync trigger xBookmarksSync --preview  # Dry run
ntn workers sync state reset xBookmarksSync      # Re-sync all bookmarks from scratch
ntn workers capabilities disable xBookmarksSync  # Pause syncing
ntn workers capabilities enable xBookmarksSync   # Resume syncing
```

> After a `state reset`, the stored (rotated) refresh token is cleared too, so
> re-set a fresh `X_REFRESH_TOKEN` (repeat step 2) before the next run.

## Development

```bash
npm install
npm run check    # typecheck
npm run build    # emit dist/
```

The worker entrypoint is `src/index.ts`; the X API client is `src/x.ts`.

## License

[MIT](./LICENSE)
