import { Worker, type Schedule } from "@notionhq/workers";
import * as Schema from "@notionhq/workers/schema";
import * as Builder from "@notionhq/workers/builder";
import {
  refreshAccessToken,
  getCurrentUserId,
  getBookmarksPage,
  type OAuthClient,
  type BookmarkTweet,
} from "./x.js";
import { toLocalISOString, summarizeTitle, buildPageBody } from "./format.js";

const worker = new Worker();

const TIMEZONE = process.env.TIMEZONE ?? "America/Los_Angeles";

// Cap the first (backlog) load so a large bookmark history doesn't page forever.
// Steady-state cycles stop at the last-synced marker well before this. Set to 0
// to disable the cap and always walk the full history.
const FULL_LOAD_LIMIT = Number(process.env.X_FULL_LOAD_LIMIT ?? "800");

// ---------------------------------------------------------------------------
// Notion database schema
// ---------------------------------------------------------------------------

const bookmarksDb = worker.database("bookmarks", {
  type: "managed",
  initialTitle: "X Bookmarks",
  primaryKeyProperty: "Tweet ID",
  schema: {
    properties: {
      Tweet: Schema.title(),
      Type: Schema.select([
        { name: "Post", color: "gray" },
        { name: "Thread", color: "blue" },
        { name: "Article", color: "purple" },
      ]),
      Author: Schema.richText(),
      URL: Schema.url(),
      Posted: Schema.date(),
      "Tweet ID": Schema.richText(),
    },
  },
});

// ---------------------------------------------------------------------------
// Sync state
// ---------------------------------------------------------------------------

interface SyncState {
  /** Rotated OAuth2 refresh token — X issues a new one on every refresh. */
  refreshToken?: string;
  /** Cached access token and its expiry (epoch ms) so we don't refresh every page. */
  accessToken?: string;
  accessTokenExpiresAt?: number;
  /** Cached numeric user id for the bookmarks path. */
  userId?: string;
  /** Newest-bookmarked tweet id from the last completed cycle (our stop marker). */
  lastNewestId?: string;
  /** Newest-bookmarked tweet id seen in the in-progress cycle (committed at cycle end). */
  cycleNewestId?: string;
  /** Cursor for continuing the current cycle across `hasMore` calls. */
  paginationToken?: string;
  /** Whether a paginating cycle is currently in progress. */
  cycleActive?: boolean;
  /** Bookmarks fetched so far in the in-progress cycle (for the full-load cap). */
  cycleFetched?: number;
}

// ---------------------------------------------------------------------------
// Change builder
// ---------------------------------------------------------------------------

function toChange(tweet: BookmarkTweet) {
  const type = tweet.isSelfThread ? "Thread" : tweet.isLongform ? "Article" : "Post";
  const fallbackEmoji = tweet.isSelfThread ? "🧵" : tweet.isLongform ? "📄" : "🔖";
  return {
    type: "upsert" as const,
    key: tweet.id,
    icon: tweet.authorProfileImageUrl
      ? Builder.imageIcon(tweet.authorProfileImageUrl)
      : Builder.emojiIcon(fallbackEmoji),
    pageContentMarkdown: buildPageBody(tweet),
    properties: {
      Tweet: Builder.title(summarizeTitle(tweet.text)),
      Type: Builder.select(type),
      Author: Builder.richText(`${tweet.authorName} (@${tweet.authorUsername})`),
      URL: Builder.url(tweet.url),
      Posted: Builder.dateTime(toLocalISOString(tweet.createdAt, TIMEZONE), TIMEZONE),
      "Tweet ID": Builder.richText(tweet.id),
    },
  };
}

// ---------------------------------------------------------------------------
// Sync definition
// ---------------------------------------------------------------------------

worker.sync("xBookmarksSync", {
  database: bookmarksDb,
  mode: "incremental",
  schedule: (process.env.SYNC_SCHEDULE ?? "1d") as Schedule,
  execute: async (prevState: SyncState | undefined) => {
    const clientId = process.env.X_CLIENT_ID;
    if (!clientId) {
      throw new Error(
        "X_CLIENT_ID not set. Run: ntn workers env set X_CLIENT_ID=your_oauth2_client_id"
      );
    }
    const client: OAuthClient = {
      clientId,
      clientSecret: process.env.X_CLIENT_SECRET || undefined,
    };

    const state: SyncState = { ...(prevState ?? {}) };

    // 1. Ensure a valid access token (refresh a minute before expiry).
    //    X invalidates the old refresh token the instant it issues a new one, so
    //    we persist the rotated token in its own execute step (returning `hasMore`
    //    to continue immediately) before doing any request that could fail and
    //    discard it — otherwise a transient fetch error would lock us out.
    if (
      !state.accessToken ||
      !state.accessTokenExpiresAt ||
      Date.now() > state.accessTokenExpiresAt - 60_000
    ) {
      const refreshToken = state.refreshToken ?? process.env.X_REFRESH_TOKEN;
      if (!refreshToken) {
        throw new Error(
          "No refresh token available. Bootstrap one with `pnpm oauth`, then " +
            "set it via: ntn workers env set X_REFRESH_TOKEN=..."
        );
      }
      const refreshed = await refreshAccessToken(client, refreshToken);
      state.accessToken = refreshed.accessToken;
      state.refreshToken = refreshed.refreshToken;
      state.accessTokenExpiresAt = Date.now() + refreshed.expiresIn * 1000;
      return { changes: [], hasMore: true, nextState: state };
    }

    // 2. Ensure we know the user id.
    if (!state.userId) {
      state.userId = await getCurrentUserId(state.accessToken);
    }

    // 3. Start a fresh cycle from the top of the bookmarks list when idle.
    if (!state.cycleActive) {
      state.cycleActive = true;
      state.paginationToken = undefined;
      state.cycleNewestId = undefined;
      state.cycleFetched = 0;
    }

    // 4. Fetch one page of bookmarks (newest-bookmarked first).
    const { tweets, nextToken } = await getBookmarksPage(
      state.userId,
      state.accessToken,
      state.paginationToken
    );

    // The very first tweet of the cycle is the new high-water mark.
    if (!state.cycleNewestId && tweets.length > 0) {
      state.cycleNewestId = tweets[0].id;
    }
    state.cycleFetched = (state.cycleFetched ?? 0) + tweets.length;

    // 5. Take tweets until we hit the last-synced marker; everything above is new.
    let reachedKnown = false;
    const fresh: BookmarkTweet[] = [];
    for (const tweet of tweets) {
      if (state.lastNewestId && tweet.id === state.lastNewestId) {
        reachedKnown = true;
        break;
      }
      fresh.push(tweet);
    }

    const changes = fresh.map(toChange);

    // 6. Continue paginating within this cycle only if there's more, we haven't
    //    caught up to what we already have, and we're under the full-load cap.
    const underCap = FULL_LOAD_LIMIT <= 0 || (state.cycleFetched ?? 0) < FULL_LOAD_LIMIT;
    const hasMore = Boolean(nextToken) && !reachedKnown && tweets.length > 0 && underCap;

    if (hasMore) {
      return {
        changes,
        hasMore: true,
        nextState: { ...state, paginationToken: nextToken },
      };
    }

    // 7. Cycle complete: commit the high-water mark and go idle until next schedule.
    return {
      changes,
      hasMore: false,
      nextState: {
        ...state,
        lastNewestId: state.cycleNewestId ?? state.lastNewestId,
        cycleActive: false,
        paginationToken: undefined,
        cycleNewestId: undefined,
        cycleFetched: undefined,
      },
    };
  },
});

export default worker;
