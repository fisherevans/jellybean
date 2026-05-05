# Watch menu (M7)

The watch menu is the pre-playback interstitial at `/kids/watch/:id`.
It surfaces a hero composition (poster, title, primary action) over a
blurred backdrop, and for series additionally renders an episode-
accordion below the hero. It exists to give kids a fast read on what
they're about to watch, and a one-button-press path into the right
piece of content.

## Routing rules

The decision of whether a tile click goes to `/play` or `/watch` lives
in `web/kids/src/Watch.tsx#shouldShowWatchMenu`. Both `Browse.tsx` and
`Library.tsx` import the helper so the rule is applied identically
everywhere a kid can pick a thing.

| Item                                  | Destination |
| ------------------------------------- | ----------- |
| Series                                | `/watch/:id` (lets the kid pick an episode) |
| Movie with `PlayedPercentage` >= 5%   | `/watch/:id` (offers Resume / Restart / Watch again) |
| Movie with `PlayedPercentage` < 5%    | `/play/:id` (no menu - just play it) |

The 5% gate is a deliberate "did the kid actually start watching this"
threshold. Below it, Jellyfin's resume position is usually noise from
a quick mistap, and showing a Resume button would be confusing.

## Back navigation

Defined in M7 #44:

- Back from `/play` -> `/watch/:id` (with the video paused). The id is
  the resolved series id when the player is on an episode, else the
  item id. This lets the kid bounce out of the player into the episode
  accordion without losing context.
- Back from `/watch` -> `/library` (or `/browse` - see note below).

The "back-to-watch" wiring lives in `Play.tsx` via a `watchHref`
constant. It's used by the header's back arrow link, the transport's
onBack, the Esc keybind, and the `onEnded` handler (so movies that
finish naturally land back on the watch menu, where Watch Again is
the primary action).

The watch screen's back button currently lands on `/browse` because
that's the kid home for the M8 Browse-by-default world. If the kid
arrived from `/library`, they'll re-enter the library by clicking the
Library tab on the browse screen.

## Hero

Movies render:

- Backdrop image (Jellyfin `Backdrop` type at width=1920) blurred and
  dimmed via CSS `filter: blur(20px) brightness(0.45)` and clipped to
  the top 60vh.
- Poster (Primary type, width=480) at 220px wide on the left.
- Title, year, runtime, and 1-2 action buttons on the right.
- Primary button is `Resume` for in-progress movies, `Watch again` for
  completed ones, `Play` otherwise. A secondary `Restart` button
  appears alongside Resume / Watch again so the kid can always start
  fresh without scrubbing.

Series render the same hero shell but the action button text is
derived from the episode list:

- "Resume S<N>E<M>" for the first in-progress episode.
- "Continue with S<N>E<M>" for the first unwatched after a completed
  run.
- "Watch again" when the entire series has been watched through.
- "Loading episodes..." while the episode list fetch is in flight (so
  the user doesn't see a misleading "Play" button that points at the
  wrong thing).

## Episode accordion (series only)

Renders below the hero on series. One section per season; specials
(season 0) and "Other" (no season number) sort to the top per Jellyfin
convention. The accordion auto-opens the season containing the resume
target so the kid sees the right entry without having to click into a
season header.

Each episode tile shows: thumbnail (Primary image, 16:9 crop), badge
("S2E04"), title, runtime, a checkmark when `Played === true`, and a
2px progress bar at the bottom when `5% <= PlayedPercentage < 90%`.

## Endpoints

- `GET /api/kids/items/:id` (M7 #40) - lightweight metadata for the
  watch menu hero. Returns `{itemId, itemName, itemType, seriesId,
  seriesName, productionYear, runtimeTicks, userData}`. Deliberately
  does NOT call PostPlaybackInfo, so opening the watch menu does not
  kick off a transcode session for content the kid hasn't decided to
  play.
- `GET /api/kids/series/:id/episodes` (M7 #40) - per-season episode
  list with UserData per episode for the accordion. Falls back to
  service-account auth when no kid token is present (admin preview)
  so the accordion still renders structure, just without per-user
  progress markers.
- `GET /api/kids/items/:id/stream` - unchanged. Hit only when the kid
  picks Play / Resume / a specific episode, so the transcode session
  starts at the right offset.

## Tests

- `web/admin/tests/kids_watch.spec.ts` - movie hero, series accordion,
  back-to-browse navigation.
- `web/admin/tests/kids.spec.ts` - back-from-/play and Esc-from-/play
  both land on `/watch/:id` (M7 #44).
- `web/admin/tests/kids_browse.spec.ts` - tile clicks route to either
  `/play` or `/watch` per the rule above.
