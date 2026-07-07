# Repository guide for agents

X bookmarks → Notion sync, deployed as a [Notion Worker](https://developers.notion.com/docs/workers). No server, no key rotation — Notion runs the worker on a schedule.

## Layout

- `src/index.ts` — worker entrypoint: database schema, sync state machine.
- `src/x.ts` — X API v2 client: OAuth2 token refresh, `users/me`, bookmarks fetch + normalization.
- `src/format.ts` — display helpers (local-time conversion, title summary, page body).
- `scripts/x-oauth.mjs` — one-time local OAuth2 PKCE bootstrap to obtain the initial refresh token.
- `worktree-setup.sh` / `worktree-archive.sh` — Conductor worktree helpers.
- `conductor.json` — Conductor workspace config.
- `.github/` — CI: `pnpm check` on push/PR; deploys on push to `master`.

No tests in-repo; correctness is enforced by `tsc --noEmit`.

## Conventions

- TypeScript, ESM (`"type": "module"`), Node 22+.
- Default branch is `master` (not `main`). PRs target `master`.
- Dependencies are deliberately minimal — just `@notionhq/workers`. Don't add libraries without a clear reason. The OAuth script is intentionally zero-dependency (Node built-ins only).

## Commands

```bash
pnpm install
pnpm check     # typecheck — run before committing
pnpm build     # emit dist/
pnpm oauth     # one-time: obtain X refresh token (needs X_CLIENT_ID env)
```

Deploy / operate (requires `ntn` CLI and a Notion login). These wrap the `ntn`
commands — see `package.json` scripts:

```bash
pnpm worker:create          # one-time: create the worker (writes workers.json)
pnpm worker:deploy          # rebuild + redeploy
pnpm worker:sync:preview    # dry run
pnpm worker:sync            # real sync
pnpm worker:status
pnpm worker:reset           # re-sync from scratch
```

Env vars consumed by the worker:
- `X_CLIENT_ID` (required) — OAuth2 client id.
- `X_CLIENT_SECRET` (required for confidential clients) — OAuth2 client secret.
- `X_REFRESH_TOKEN` (bootstrap only) — the initial refresh token. After the first
  run the worker stores the rotated token in its own sync state and ignores this.
- `TIMEZONE` (optional, defaults to `America/Los_Angeles`).
- `SYNC_SCHEDULE` (optional, defaults to `1d`).
- `X_FULL_LOAD_LIMIT` (optional, defaults to `800`) — caps how many bookmarks the
  first backlog load walks; set to `0` for the full history.

## How the sync behaves

- **Auth:** refreshes an OAuth2 access token from the refresh token; X rotates the
  refresh token on every use, so the rotated token is persisted in sync state.
- **Incremental:** stores the newest-bookmarked tweet id from the last completed
  cycle and stops paginating once it's reached again.
- **One page per `execute` call:** large backlogs paginate across `hasMore` calls,
  which keeps each call light and rate-limit friendly. The first backlog load is
  bounded by `X_FULL_LOAD_LIMIT`.
- **Upsert by tweet id** — re-runs are safe.
- **Resilient fetches:** `users/me` and bookmarks GETs retry transient 5xx /
  network errors with exponential backoff (`fetchWithRetry` in `src/x.ts`). The
  token refresh is deliberately *not* retried — X rotates (and invalidates) the
  refresh token server-side even on a failed-looking response.
- **Access tier:** the bookmarks endpoint needs OAuth 2.0 user-context auth with
  `bookmark.read`. As of 2026 X defaults new accounts to **pay-per-use** billing;
  bookmarks are "owned reads" (~$0.001/resource), so no flat Basic/Pro plan is
  required — a full 800-bookmark load costs well under a dollar.

When changing sync behavior, preserve these invariants unless the user explicitly asks otherwise.

## Before opening a PR

1. `pnpm check` passes.
2. PR base is `master`.
3. Keep diffs minimal — this is a small, focused repo.
