// dateBuckets buckets items by their dateCreated or
// userData.lastPlayedDate timestamps into named groups. Used by
// Library and TagDetail when sort is recently_added or
// recently_watched to render time-grouped sections instead of a
// flat grid.
//
// Buckets are exclusive non-overlapping ranges, computed in the
// kid TV's local timezone (Date is local), so "today" matches the
// kid's clock-day rather than UTC.
//
//   today    - timestamp on or after midnight today
//   week     - within the past 7 days, excluding today
//   month    - within the past 30 days, excluding the past 7
//   quarter  - within the past 90 days, excluding the past 30
//   year     - within the past 365 days, excluding the past 90
//   earlier  - more than 365 days ago
//   never    - (watched only) lastPlayedDate missing / invalid
//
// Within each non-"never" bucket, input order is preserved - the
// server already returns items sorted by the relevant field in
// descending order, so each bucket is naturally recency-ordered.
// The "never" bucket is sorted alphabetically by name regardless
// of the parent sort, so the trailing tail stays stable.

export type AddedBucket =
    | "today"
    | "week"
    | "month"
    | "quarter"
    | "year"
    | "earlier";
export type WatchedBucket = AddedBucket | "never";

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfTodayMs(): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

function classify(ts: number, todayStart: number): AddedBucket | null {
    if (!Number.isFinite(ts)) return null;
    if (ts >= todayStart) return "today";
    if (ts >= todayStart - 6 * DAY_MS) return "week";
    if (ts >= todayStart - 29 * DAY_MS) return "month";
    if (ts >= todayStart - 89 * DAY_MS) return "quarter";
    if (ts >= todayStart - 364 * DAY_MS) return "year";
    return "earlier";
}

function parseTs(s: string | undefined): number {
    if (!s) return NaN;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : NaN;
}

export const ADDED_ORDER: AddedBucket[] = [
    "today",
    "week",
    "month",
    "quarter",
    "year",
    "earlier",
];
export const WATCHED_ORDER: WatchedBucket[] = [
    "today",
    "week",
    "month",
    "quarter",
    "year",
    "earlier",
    "never",
];

export function bucketByAdded<T extends { dateCreated?: string }>(
    items: T[],
): Record<AddedBucket, T[]> {
    const out: Record<AddedBucket, T[]> = {
        today: [],
        week: [],
        month: [],
        quarter: [],
        year: [],
        earlier: [],
    };
    const todayStart = startOfTodayMs();
    for (const it of items) {
        const ts = parseTs(it.dateCreated);
        const bucket = classify(ts, todayStart);
        out[bucket ?? "earlier"].push(it);
    }
    return out;
}

export function bucketByWatched<
    T extends {
        name: string;
        userData?: { lastPlayedDate?: string };
    },
>(items: T[]): Record<WatchedBucket, T[]> {
    const out: Record<WatchedBucket, T[]> = {
        today: [],
        week: [],
        month: [],
        quarter: [],
        year: [],
        earlier: [],
        never: [],
    };
    const todayStart = startOfTodayMs();
    for (const it of items) {
        const raw = it.userData?.lastPlayedDate;
        if (!raw) {
            out.never.push(it);
            continue;
        }
        const ts = parseTs(raw);
        const bucket = classify(ts, todayStart);
        if (bucket === null) {
            out.never.push(it);
            continue;
        }
        out[bucket].push(it);
    }
    out.never.sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
    return out;
}
