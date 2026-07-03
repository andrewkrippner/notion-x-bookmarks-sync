import type { BookmarkTweet } from "./x.js";

/**
 * Convert a UTC instant to a local wall-clock ISO string (YYYY-MM-DDTHH:MM:SS).
 *
 * `Builder.dateTime` reads the ISO components literally and attaches the given
 * timezone as a display label, so we must pre-convert the instant to the
 * target timezone's wall-clock time here.
 */
export function toLocalISOString(utcISO: string, timeZone: string): string {
  const date = new Date(utcISO);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  // en-CA renders midnight as "24" in some engines; normalize to "00".
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
}

/** Collapse a tweet to a single-line title, capped for readability. */
export function summarizeTitle(text: string, maxLength = 120): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return "(no text)";
  if (oneLine.length <= maxLength) return oneLine;
  return `${oneLine.slice(0, maxLength - 1).trimEnd()}…`;
}

/** Build the Notion page body: full tweet text, any images, and a permalink. */
export function buildPageBody(tweet: BookmarkTweet): string {
  const sections: string[] = [];

  const text = tweet.text.trim();
  if (text) sections.push(text);

  for (const url of tweet.mediaUrls) {
    sections.push(`![media](${url})`);
  }

  sections.push(`[View on X →](${tweet.url})`);

  return sections.join("\n\n");
}
