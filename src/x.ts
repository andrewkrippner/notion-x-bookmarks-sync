// ---------------------------------------------------------------------------
// X (Twitter) API v2 client
//
// The bookmarks endpoint (GET /2/users/:id/bookmarks) requires OAuth 2.0
// user-context auth with the `bookmark.read` scope, and is only available on
// paid API tiers (Basic and up). We use the Authorization Code + PKCE flow's
// refresh token to mint short-lived access tokens on each run. X rotates the
// refresh token on every use, so the caller must persist the returned one.
// ---------------------------------------------------------------------------

const X_API_BASE = "https://api.x.com/2";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";

/** Base64-encode a string, preferring the platform btoa and falling back to Buffer. */
function base64(input: string): string {
  const g = globalThis as { btoa?: (s: string) => string };
  if (typeof g.btoa === "function") return g.btoa(input);
  return Buffer.from(input, "utf8").toString("base64");
}

export interface OAuthClient {
  clientId: string;
  /** Present for confidential clients; omit for public (PKCE-only) clients. */
  clientSecret?: string;
}

export interface RefreshedToken {
  accessToken: string;
  /** The rotated refresh token — persist this for the next run. */
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
}

/** Exchange a refresh token for a fresh access token (and a rotated refresh token). */
export async function refreshAccessToken(
  client: OAuthClient,
  refreshToken: string
): Promise<RefreshedToken> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: client.clientId,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (client.clientSecret) {
    headers["Authorization"] = `Basic ${base64(`${client.clientId}:${client.clientSecret}`)}`;
  }

  const res = await fetch(TOKEN_URL, { method: "POST", headers, body });
  if (!res.ok) {
    throw new Error(`X token refresh failed ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    accessToken: json.access_token,
    // X normally returns a new refresh token; fall back to the old one if not.
    refreshToken: json.refresh_token ?? refreshToken,
    expiresIn: json.expires_in,
  };
}

/** Look up the authenticated user's numeric id (needed for the bookmarks path). */
export async function getCurrentUserId(accessToken: string): Promise<string> {
  const res = await fetch(`${X_API_BASE}/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`X users/me failed ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { data: { id: string } };
  return json.data.id;
}

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------

export interface BookmarkTweet {
  id: string;
  /** Full text — the long-form note_tweet body when present, else the tweet text. */
  text: string;
  /** Tweet creation time as an ISO-8601 UTC string. */
  createdAt: string;
  authorName: string;
  authorUsername: string;
  authorProfileImageUrl?: string;
  /** Canonical https://x.com/<user>/status/<id> permalink. */
  url: string;
  /** True when this tweet is a reply to another tweet by the same author (a thread continuation). */
  isSelfThread: boolean;
  /** Photo/preview image URLs attached to the tweet. */
  mediaUrls: string[];
}

interface XUser {
  id: string;
  name: string;
  username: string;
  profile_image_url?: string;
}

interface XMedia {
  media_key: string;
  type: string;
  url?: string;
  preview_image_url?: string;
}

interface XTweet {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  conversation_id?: string;
  note_tweet?: { text: string };
  referenced_tweets?: { type: string; id: string }[];
  attachments?: { media_keys?: string[] };
}

interface BookmarksResponse {
  data?: XTweet[];
  includes?: {
    users?: XUser[];
    tweets?: XTweet[];
    media?: XMedia[];
  };
  meta?: { result_count: number; next_token?: string };
}

export interface BookmarksPage {
  tweets: BookmarkTweet[];
  nextToken?: string;
}

/** Fetch one page (up to 100) of the authenticated user's bookmarks, newest-bookmarked first. */
export async function getBookmarksPage(
  userId: string,
  accessToken: string,
  paginationToken?: string
): Promise<BookmarksPage> {
  const params = new URLSearchParams({
    max_results: "100",
    "tweet.fields": "created_at,author_id,conversation_id,note_tweet,referenced_tweets,attachments",
    expansions: "author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id",
    "user.fields": "name,username,profile_image_url",
    "media.fields": "url,preview_image_url,type",
  });
  if (paginationToken) params.set("pagination_token", paginationToken);

  const res = await fetch(`${X_API_BASE}/users/${userId}/bookmarks?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`X bookmarks fetch failed ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as BookmarksResponse;

  const usersById = new Map<string, XUser>(
    (json.includes?.users ?? []).map((u) => [u.id, u])
  );
  const tweetsById = new Map<string, XTweet>(
    (json.includes?.tweets ?? []).map((t) => [t.id, t])
  );
  const mediaByKey = new Map<string, XMedia>(
    (json.includes?.media ?? []).map((m) => [m.media_key, m])
  );

  const tweets: BookmarkTweet[] = (json.data ?? []).map((t) => {
    const author = t.author_id ? usersById.get(t.author_id) : undefined;
    const username = author?.username ?? "i";

    // A thread continuation: this tweet replies to another tweet by the same author.
    const isSelfThread = (t.referenced_tweets ?? []).some((ref) => {
      if (ref.type !== "replied_to") return false;
      const parent = tweetsById.get(ref.id);
      return parent?.author_id != null && parent.author_id === t.author_id;
    });

    const mediaUrls = (t.attachments?.media_keys ?? [])
      .map((key) => mediaByKey.get(key))
      .map((m) => m?.url ?? m?.preview_image_url)
      .filter((u): u is string => Boolean(u));

    return {
      id: t.id,
      text: t.note_tweet?.text ?? t.text,
      createdAt: t.created_at ?? new Date(0).toISOString(),
      authorName: author?.name ?? username,
      authorUsername: username,
      authorProfileImageUrl: author?.profile_image_url,
      url: `https://x.com/${username}/status/${t.id}`,
      isSelfThread,
      mediaUrls,
    };
  });

  return { tweets, nextToken: json.meta?.next_token };
}
