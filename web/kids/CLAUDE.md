# Kid TV App — Build Guide

This guide is for working on `web/kids/` — the React/TypeScript app the
kid uses on the Skyworth Android TV (and any other future TV target).

It captures the perf, navigation, and visual decisions that have already
been worked out the hard way. Read it before adding a new feature so the
next page feels like the rest of the app.

The parent admin web (`web/admin/`) is a different beast — it runs in a
desktop browser, not a TV WebView, and many of these rules don't apply
there.

## Audience and constraints

* The user is a kid driving a D-pad remote (D-pad arrows + center
  Enter + Back). No mouse. No keyboard. They cannot type — text input
  on a TV remote is miserable.
* The TV is **slow**: a Skyworth running Android TV 11 with whatever
  WebView ships with that. The Performance class is closer to a 2014
  desktop than to a current laptop. Test there before declaring a
  feature done — Chrome on a M-series Mac is not a representative
  build target.
* The Anthropic SDK / dev environment runs against `scripts/jb` for
  the daemon and `scripts/jb-tv install/launch` for pushing the APK +
  reloading the WebView.

## Architecture at a glance

```
main.tsx              router + global keyboard shim + splash gate
KidsHome.tsx          shared layout for /browse, /library, /tags + /tags/:id
  TabPill.tsx         top tab nav (single instance, persists across page swaps)
  MainMenuModal.tsx   menu overlay (signed-out / refresh / perf / etc.)
Browse.tsx            home grid: virtualized rows + transform-scrolled stack
Library.tsx           search + filter + grid + cw + alpha picker
Tags.tsx              landscape tag cards
TagDetail.tsx         in-tag grid (alpha / recently watched / recently added)
Watch.tsx             pre-playback interstitial
Play.tsx              video player + custom transport
OverrideModal.tsx     PIN-gated adult override (M9), used everywhere a tile is focused
auth.ts               localStorage session + Android bridge mirroring
kidNav.ts             home-tab pointer + tab-arrow flag (sessionStorage)
useBrowseRowAnimator  rAF horizontal track animator
smoothScroll.ts       rAF-driven scroll easers (window or element scroll)
perfMode.ts           body[data-perf="slow"|"fast"] from heuristic + FPS sample
perfOverlay.ts        FPS / longtask / LoAF debug overlay (off by default)
```

The bg, TabPill, menu modal, and tab-focus state live in `KidsHome`.
Pages render via `<Outlet/>` and consume layout state via
`useKidsHome()`.

## Performance — the hard-won rules

Cheap Android WebViews lie in the Performance pane and cost a lot
when you don't follow these.

### How to tell where a freeze is coming from

* Long tasks attributed to `name="self"` in PerformanceObserver are
  **paint / composite / layout work, not JavaScript**. If LoAF
  (`PerformanceLongAnimationFrameTiming`) shows `blocking=0,
  scripts=0, render=~5ms, total=1500ms`, the WebView is stuck on
  raster or composite — usually image decode or oversized painted
  layers. Do not look for a JS culprit.
* Toggle the perf overlay from Menu → "Turn on perf overlay". It
  logs LoAF entries with `topScripts` attribution + a live
  FPS / BLK / PEAK / MEM HUD. Reload-required because it's gated
  on `localStorage["jellybean.kids.perfDebug"]`.
* `chrome://inspect` Performance tab works for short recordings.
  Long ones won't render — the trace overwhelms the devtools UI.

### Page-level scroll is poison

`window.scrollTo({top: N})` triggers a full-viewport repaint per call
on this WebView. Even **one** call can take 3-4 seconds when the page
has a lot of content.

* All home tabs (Browse, Library, Tags) and TagDetail use
  **transform-based scroll**: a wrapper element has
  `transform: translate3d(0, Y, 0)` driven by an rAF animator.
* Body is `overflow: hidden` on every kid page via the
  `.kids-scroll-active` class. KidsHome adds it for /browse, /library,
  /tags. Pages OUTSIDE KidsHome (TagDetail) add it themselves via
  `useStackScroll`.
* The TabPill sits in a slot wrapper (`.kids-tabpill-slot`) whose
  transform reads `var(--kids-scroll-y)`. Browse writes that
  variable from its inline animator; Library and Tags write it via
  `useStackScroll`.
* `useStackScroll` (`web/kids/src/useStackScroll.ts`) is the shared
  hook for any new page that needs vertical scroll. It returns
  `{ stackRef, setStackY, scrollToTop, scrollToCenter, stackYRef }`
  and adds the body class on mount. Wrap content in
  `<div ref={stackRef} className="kids-stack page-stack">…</div>`.
  Top padding on the stack must clear the absolutely-positioned
  TabPill: `padding-top: calc(var(--kids-tabpill-height, 90px) + …)`.
* The legacy `smoothScroll.smoothScrollTo(window, …)` helper is no
  longer used by long-content pages — its slow-mode escape-hatch
  snapped instead of animated, which the kid sees as the page
  jump-cutting on every Down press. Don't reintroduce it on any
  new page; reach for `useStackScroll` instead.

### CSS filters are paint-time on this WebView

Don't use `filter: hue-rotate`, `filter: blur`, etc. in animations
that run per scroll frame. We tried hue-shifting the bg with scroll
to give a "feels alive" effect — it was just as expensive as
animating bg-position-y, because filter-rotate isn't composite-only
on this WebView.

For idle drifts (no input), filter or position animations at low
frequency (5-10 FPS via setInterval) are acceptable, but pause them
during navigation animations.

### Image decode is the dominant cost on cross-row navigation

A row of 21 tiles, each requesting a 240x360 poster, will choke
the rasterizer for 1-3 seconds the first time the row enters the
viewport. The compositor stalls on per-image decode work. Always:

* `<img loading="lazy" decoding="async">` so off-viewport images
  defer, but the WebView's IntersectionObserver-style lazy is not
  enough when the kid scrolls fast.
* **Server-side image width matches render size** (or smaller).
  Browse tiles render at ~220px CSS, the server sends `width=160`.
  Smaller image == faster decode.
* **Render-priority gating** for off-window rows. Tile takes a
  `priority` prop — when false it renders an empty placeholder div
  instead of an `<img>` tag. Browse and Library compute
  priority as "row is within +/- N of focused row".
* **Latch priority once warm.** A `warmRowsRef: Set<number>` adds
  rows that have been rendered with priority. The latch never
  releases until the page unmounts. This means a kid arrowing
  back through previously-warmed rows sees no decode flicker.
* **Progressive warm-up.** A `setInterval` slowly grows the
  priority radius while the page sits idle, so by ~30s all rows are
  warm regardless of where the kid has navigated.

### The other big rasterizer trap: giant painted layers

Avoid putting a heavy bg on an element that gets transformed.
`.browse-stack` is **transparent** by design — the rainbow bg lives
on `.kids-home-bg` (a separate `position: fixed` layer behind
everything). A previous build painted the bg on `.browse-stack`,
which made the GPU treat the whole stack as a giant painted texture
and re-rasterize it on every transform. Multi-second freezes
followed.

Rule: *the element you transform should have no children with
`contain: paint` and no own background. It's a positional shell, not
a painted surface.*

### Forced layouts

Reading `offsetWidth`, `offsetTop`, `clientHeight`, or
`getBoundingClientRect()` after a DOM mutation flushes layout. If the
page has hundreds of mounted nodes, that flush takes 200-400ms.

* `useBrowseRowAnimator` measures the per-tile advance ONCE per
  mount and caches it; it re-measures only on `resize`.
* The Browse focus useEffect skips `scrollWindowToCenter` when the
  arrow press kept the kid in the same row.
* When you must read layout, do it as late as possible (in the
  effect, not during render) and as few times as possible.

### Layout containment

`.tile { contain: layout; }` and `.browse-row { contain: layout
paint; }` bound layout invalidation when class names flip on
focused elements. Without these, a `.focused` toggle on one tile
invalidates layout for the entire page.

`contain: paint` is a paint-only hint — safe on rows because the
focused tile's `transform: scale(1.12)` bleed is absorbed by the
row's own padding-top/bottom.

### Memoize tiles aggressively

Tile is `React.memo`'d with a custom equality:

```ts
(prev, next) =>
    prev.item === next.item &&
    prev.size === next.size &&
    prev.focused === next.focused &&
    prev.showProgress === next.showProgress &&
    prev.priority === next.priority
```

Note: callback identity (`onClick`, `onFocus`, `refCallback`) is
**ignored**. Parents pass fresh closures every render; if memo used
the default shallow-equal, every focus change would re-render
every tile. Stable refs / setState updaters mean the closure stays
semantically correct.

### Slow-mode CSS overrides

`body[data-perf="slow"]` selectors collapse expensive effects:

* Tile focus uses outline (composited) instead of box-shadow
  (paint) and skips the padding shift (no layout reflow).
* Tile transitions disabled — snap-to-focus.
* Drop-shadow filters dropped (filters are paint-time).
* TabPill highlight transitions disabled — snap between tabs.

If you add a new visual effect, gate the expensive variant on
`!body[data-perf="slow"]`. Cheap variant should still look
deliberate, not broken.

### The animator pattern

Used by both `useBrowseRowAnimator` (horizontal track) and Browse's
inline stack animator. Pattern:

```ts
const currentRef = useRef<number>(0);
const targetRef = useRef<number>(0);
const rafRef = useRef<number | null>(null);

function step() {
    const dist = targetRef.current - currentRef.current;
    if (Math.abs(dist) < SETTLE_PX) {
        currentRef.current = targetRef.current;
        applyVisual(currentRef.current);
        rafRef.current = null;
        return;
    }
    const ease = body.dataset.perf === "slow" ? 0.36 : 0.22;
    const next = currentRef.current + dist * ease;
    currentRef.current = next;
    applyVisual(next);
    rafRef.current = requestAnimationFrame(step);
}

function setTarget(y: number, snap = false) {
    targetRef.current = y;
    if (snap) {
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        currentRef.current = y;
        applyVisual(y);
        return;
    }
    if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(step);
    }
    // Mid-flight retargets are free — the loop reads targetRef on
    // its next frame and eases from currentRef toward the new
    // target with no restart-from-zero.
}
```

Higher ease constant on slow devices = fewer animator frames =
less time for a per-frame hitch to land mid-motion. Snap-from-rest
on first paint so back-navigation lands instantly on the previous
position.

## Navigation — the focus model

### Three-layer focus

Every kid page has three logical focus layers, in priority order
when Back is pressed:

1. **Modal layer.** OverrideModal, MainMenuModal, AlphaPickerModal.
   Owns its own keys via `onKeyDown` on the backdrop div with
   `e.stopPropagation`. Page listeners early-return while a modal
   is open.
2. **Tab nav layer.** TabPill in KidsHome layout. Active when
   `tabFocused === true`. Owns Left/Right/Down/Enter via its own
   window keydown listener (gated on `focused` prop).
3. **Page chrome + content layer.** Per-page focus state machine
   (search/filter/alpha/cw/grid for Library; back/sort/tile for
   TagDetail; tile for Browse). Active when `tabFocused === false`.

`useKidsHome()` returns `{ tabFocused, setTabFocused, openMenu }`.
Pages read `tabFocused` for visual gating (e.g. `focused = !tabFocused
&& isSelf`) and call `setTabFocused(true)` when their internal Up
arrow runs off the top.

### When tabFocused engages, three things happen everywhere

Every home page (Browse, Library, Tags) has the same effect:

```ts
useEffect(() => {
    if (!tabFocused) return;
    // Cancel any in-flight smoothScroll animator FIRST. A
    // scrollWindowToCenter targeting the previously-focused tile
    // keeps writing scrollY each rAF; without the cancel it
    // overwrites our scrollTo(0) one frame later. This is the
    // recurring "Back doesn't actually scroll to the top"
    // regression - call cancelSmoothScroll(window) every time.
    cancelSmoothScroll(window);
    // Scroll content back to top.
    window.scrollTo({ top: 0 });   // or setStackY(0, true) on Browse
    // Drop DOM focus from any leftover tile so :focus pseudo clears.
    if (document.activeElement instanceof HTMLElement &&
        document.activeElement !== document.body) {
        document.activeElement.blur();
    }
}, [tabFocused]);
```

This handles back-press, mount-with-stale-body-scroll, and
re-arrival from a sibling tab uniformly. Don't skip the blur — the
WebView keeps `:focus` on the previously-active tile if you don't
explicitly clear it, even when the visual `.focused` class is gone.

For Browse, **snap** the stack (`setStackY(0, true)`) instead of
animating. Animating to 0 looks like the page is gliding back when
the kid explicitly asked for an exit, and the snap aligns with the
tab nav appearing immediately. Browse's stack animator is its own
rAF loop separate from `smoothScroll`, so the `setStackY(0, true)`
snap path is what drains it - `cancelSmoothScroll(window)` does
nothing for Browse since the body itself never scrolls there.

### Back-then-Down focus contract

When the kid presses Back from a content tile, three things must
happen *together* in the back handler — not split across separate
effects that race each other:

1. `setTabFocused(true)` so the tab nav re-engages.
2. `setFocus(<page's first content slot>)` so the page's internal
   focus model is reset. For Library that's `{kind: "search"}`; for
   Browse that's `{kind: "tile", row: 0, col: 0}`; for Tags that's
   `setFocusIdx(0)` (Tags uses a flat index, not a discriminated union).
3. Wipe any column / row memory the page uses to remember "where
   the kid was" (`rowColMemoryRef.current.clear()`,
   `prevFocusRowRef.current = null`, `lastTileRef.current = {row:
   0, col: 0}` on Browse).

**Exception: dive-in pages with their own back-target.** TagDetail
is reached by Enter on a tag card and lives outside KidsHome (no
tab nav). Its Back handler navigates to `/tags` directly; the
expectBackFromDetail one-shot flag in sessionStorage tells the
remounted Tags page to restore the entered card's highlight. That
restore IS intentional — the kid hasn't "left" the tags context,
they backed out of one tag. Don't confuse that with the
back-then-down contract above; the contract applies to home-tab
pages where the tab nav is the kid's exit point.

```ts
useProgressiveBack(useCallback(() => {
    if (override) { setOverride(null); return true; }
    if (!tabFocused) {
        setTabFocused(true);
        setFocus(/* page's first content slot */);
        // wipe per-page focus memory here too
        return true;
    }
    return false;
}, [...]));
```

**Why this is load-bearing:** without resetting `focus` in the
same render as `tabFocused`, the focus DOM-management effect runs
on the next render with the OLD focus state pointing at the
previous tile. It re-focuses that tile and `scrollWindowToCenter`s
to it BEFORE a separate "wasTabFocused" effect can flip focus to
the first slot. The kid sees the body scroll DOWN to the tile,
then back UP to the top — and the Down keypress that follows
re-lands them on that same tile because focus is "still" there.

**Why a separate `wasTabFocused` effect is not enough:** that
effect only fires when `tabFocused` changes, and it runs AFTER
focus DOM-management on the same render cycle (declaration
order). The focus DOM-management already saw the stale focus
state and acted on it before the reset effect committed. Reset
in the back handler so both states change in a single batch.

**Test contract:** `web/admin/tests/kids_back_focus.spec.ts`
asserts both pages: after Back, body/stack is at 0, tab pill has
DOM focus, no `.tile.focused` exists. After the next Down, focus
lands on the page's first slot — NOT the previously-focused tile.
Add a case there before changing focus / scroll behavior.

### Hand-off in both directions

* **Down from tab nav** → KidsHome calls `onFocusContent` which is
  `() => setTabFocused(false)`. Pages watch the false transition with
  a `wasTabFocused` ref:
  ```ts
  const wasTabFocused = useRef(true);
  useEffect(() => {
      if (wasTabFocused.current && !tabFocused) {
          setFocus({ kind: "search" }); // or first tile, or back btn
      }
      wasTabFocused.current = tabFocused;
  }, [tabFocused]);
  ```
* **Up at the topmost content row** → page sets `setTabFocused(true)`.
  Library does this when ArrowUp comes from search/alphaBtn/filter.
  Browse does it when ArrowUp comes from row 0. TagDetail does it
  when ArrowUp comes from back/sort.

### Left/Right on tab nav navigates immediately

TabPill's keyboard handler calls `nav(href)` on Left/Right. The
KidsHome layout persists across the route change, so `tabFocused`
stays true through the swap and the new active tab's button gets
focused via the layout's `useEffect([tabFocused, active])`.

### Save / restore scroll position

Don't always-save-on-unmount. Use a one-shot flag:

```ts
const navToWatch = (id) => {
    sessionStorage.setItem("jellybean.kids.<page>.scrollY", String(window.scrollY));
    sessionStorage.setItem("jellybean.kids.<page>.expectBack", "1");
    nav(`/watch/${id}`);
};

// In mount effect:
const expecting = sessionStorage.getItem(EXPECT_BACK_KEY) === "1";
sessionStorage.removeItem(EXPECT_BACK_KEY);
if (!expecting) return;  // don't restore for tab navigations
// ... read scrollY, scrollTo(0, y) ...
```

Without the flag, navigating Library → Tags → Library would jump
back to the kid's old grid position, which is confusing.

Browse uses the same pattern via `EXPECT_BACK_KEY` to gate the
"focus the last-played tile" restore.

### useLongPressEnter — short vs. long Enter on a tile

The hook owns Enter for any focused tile via a **capture-phase
window listener** with `preventDefault + stopPropagation`. This
suppresses both the browser's button-click-on-keyup AND any other
window listener (e.g. the page's own onKey). The hook then
synthesizes the short-press action (`onShortPress`) on keyup
before the timer, or fires `onLongPress` after.

* Hold duration: **1000ms** (used for both menu-from-tab-nav and
  override-from-tile).
* `e.repeat` keydowns are swallowed so a held Enter from the
  long-press fire doesn't trigger anything in the freshly-mounted
  modal.
* Each modal that can be opened by a held Enter ALSO ignores
  `e.repeat` in its own keydown handler (defense in depth — the
  hook's gate flips when its `enabled` prop goes false because the
  modal opened, so subsequent repeats reach the modal).
* The hook is gated on `enabled` (typically: `!!focusedItem &&
  !!session && override === null && !tabFocused`). When disabled,
  Enter goes through normal flow (the page's onKey handles it for
  non-tile focus targets).

### Progressive Back

`useProgressiveBack(callback)` registers a callback that returns
true if it consumed Back, false to fall through. Standard pattern:

```ts
useProgressiveBack(useCallback(() => {
    if (anyModalOpen) { closeModal(); return true; }
    if (!tabFocused && innerFocus !== "topMostChrome") {
        moveFocusUpOneLayer();
        return true;
    }
    if (!tabFocused) {
        setTabFocused(true);
        return true;
    }
    // Tab nav focused: this page consumed enough. Caller falls
    // through to history.back() / WebView Activity.
    return false;
}, [...deps]));
```

For pages OUTSIDE KidsHome (Watch, Play), there's no tab nav —
last Back fires `nav(getHomeTab())` to return to whichever home
tab the kid was on.

## Visual style

The kid app is bright, rounded, peer-friendly, and consistent.

### The shared rainbow bg

* Lives on `.kids-home-bg` (in KidsHome layout). Position fixed,
  inset 0, behind everything.
* SVG tile (`/public/browse-bg-tile.svg`) — pre-rasterized
  diagonal rainbow with watercolor blobs. **Never use a CSS
  multi-stop gradient or an inline <svg> for the bg** — the SVG is
  cached as a single bitmap; CSS gradients re-rasterize on every
  transform.
* Per-tab random vertical offset: KidsHome generates one lazily on
  first visit per (browse / library / tags) tab, persists in a
  ref for the session. Stored as both a CSS variable
  (`--kids-bg-offset-y`) and a numeric dataset attribute
  (`dataset.kidsBgOffsetY`) so JS can read it without unit parsing.
* On `/browse` only, Browse's animator also writes
  `--kids-bg-pos-y` per frame (offset + scroll Y) so the rainbow
  scrolls with the stack. CSS uses
  `var(--kids-bg-pos-y, var(--kids-bg-offset-y, 0))` so other
  tabs read the static offset.

If you add a new home-level page, render it inside KidsHome (via
the `<Route element={<KidsHome />}>` wrapper). Don't let pages own
their own bg — that's how Library got the white-bar-at-the-top
bug we just fixed.

### Pills are the primitive

The shared visual is a **rounded white pill on transparent bg**.
Selected/active state = white-filled pill. Focus state = inset
white outline ring (3px) creating a "spaced border" look.

Components using this:

| Selector | When white-filled | When white-outlined |
| -------- | ----------------- | ------------------- |
| `.kids-tabpill-tab.active` | current tab | (TabPill has its own animated highlight) |
| `.kids-tabpill-frame.focused` | — | tab nav has focus |
| `.filter-pill.active` | active filter (All/Movies/TV) | — |
| `.filter-pill.focused` | — | D-pad cursor on it |
| `.library-search-wrap` | always (search input bg) | D-pad cursor on it |
| `.library-alpha-btn` | — | D-pad cursor on it |

Default text color is white with `text-shadow: 0 1px 4px rgba(0,
0, 0, 0.45)` so it reads on the rainbow bg. Active state flips to
`color: #20162e` (dark purple) with no text-shadow.

### Other established patterns

* **Tile poster** — 2:3 aspect ratio, 14px inner radius, white
  4-5px ring with 4px inner padding gap when focused (slow mode
  switches to outline-offset-only so there's no layout reflow).
* **AlphaPickerModal** — white card with a 2.2rem black title.
  Letter highlight is `#2679ff` (blue) with white spaced ring,
  not the kid app's accent magenta. Keep that blue if you build
  similar pickers.
* **Tag card on `/tags`** — landscape: title (large) + description
  (clamped to 3 lines) + count on the left, poster strip on the
  right. White bg with the same focus ring pattern.
* **Tag detail header** — back button (text-only, focus ring on
  D-pad), title with optional Phosphor icon to the left, sort
  toggle pills on the right.

### Icons

`@phosphor-icons/react` `weight="fill"` for kid-facing UI (peer to
the rainbow's saturation). Allow-list any tag icon names through
`tagIcons.ts` so admin-set icons that we later remove don't crash
the kid client.

## Per-page scroll behavior

* On focus change, the focused element should be **at the top** of
  the viewport (when at the top of the content) or **centered**
  (deeper). Never let it land mid-bottom — the kid loses orientation.
* First content row pins to top alongside the page chrome.
* `scrollWindowToCenter(el)` and `scrollWindowToTop()` from
  `smoothScroll.ts` handle this; they retarget mid-animation
  cleanly under rapid presses.
* On Browse, vertical motion is via `setStackY(target)` (transform);
  same retarget guarantee.

## Adding a new feature — checklist

1. **Where does it live?** A new home tab? Add it to `TabPill`'s
   `TABS` array, `pathToTab` in KidsHome, the route in main.tsx,
   the bg-offset record. A sub-page (like TagDetail)? Still wrap
   in KidsHome so the tab nav + bg are shared.
2. **Focus state machine.** Define the kinds (`back`, `sort`,
   `tile`, etc.). Wire `tabFocused`-watching effects (top-level
   blur + scrollTo top, wasTabFocused → focus content's entry
   point). Window keydown listener gated on `!tabFocused &&
   !modalOpen`.
3. **Long-press Enter.** If the page has tile-like content,
   `useLongPressEnter({ enabled, onShortPress, onLongPress })`. If
   not, leave it alone.
4. **Progressive Back.** Standard ladder: modal → content focus
   → tab focus → fall through.
5. **Visual.** Reuse `.filter-pill`, the search wrap pattern, the
   tile component. Don't introduce a new color palette — use the
   established white/dark + accent + tag-blue (#2679ff).
6. **Slow-mode test.** Run the new page on the actual TV before
   declaring done. The Mac dev box can't simulate WebView raster
   speeds.
7. **Image strategy.** If the page renders posters: lazy + small
   width + per-row `priority` gating + warm latch + progressive
   widening. Don't render `<img>` tags eagerly.
8. **Save / restore.** If kid can leave to /watch and come back,
   use the EXPECT_BACK one-shot flag pattern. Don't always-save.
9. **Perf overlay** is your friend. Toggle from Menu while
   developing; LoAF logs `topScripts` so you'll see which
   handler runs in slow frames.

## Visual-focus gating on `tabFocused`

Inside KidsHome, every focusable element's visual highlight must
gate on `!tabFocused && <isThisElementFocused>`, **including
`tabIndex`**. The page's internal `focus` state doesn't change
when the layout's `tabFocused` flips, so without this gate the
previously-focused element keeps its `.focused` class after the
kid navigates back up to the tab nav — multiple things appear
selected at once.

Example (Library):

```tsx
<button className={`filter-pill ${active ? "active" : ""} ${
    !tabFocused && isFocused(focus, "filter", i) ? "focused" : ""
}`}
   tabIndex={!tabFocused && isFocused(focus, "filter", i) ? 0 : -1}
>
```

The CSS `:focus` half of `.tile.focused, .tile:focus { ... }` is
handled separately: KidsHome's `useEffect([tabFocused, active])`
imperatively focuses the active tab pill button when `tabFocused`
goes true, which moves DOM focus off whatever was focused before
and clears the `:focus` pseudo-class everywhere else. Don't skip
that imperative focus call — without it, the previously-focused
element keeps `:focus` even after the class is removed.

**TagDetail** is the exception — it lives outside KidsHome (no
`tabFocused`) so its single focus state machine just needs
mutually-exclusive kinds.

## Anti-patterns we've already learned to avoid

* `window.scrollTo` per animation frame — multi-second freeze.
* CSS gradient bg on a transformed element — giant painted layer,
  slow re-raster.
* `filter: hue-rotate` per scroll frame — paint-time, not
  composite-time on this WebView.
* `loading="eager"` on tile images at scale — decode pipeline
  chokes the rasterizer for seconds.
* Always-save-on-unmount + always-restore-on-mount for scroll
  position — fires on tab navigations, not just back-from-detail.
* Auto-focus a content tile on page mount — kids get confused;
  default focus stays on tab nav unless explicitly returning from
  /watch (via EXPECT_BACK flag).
* Splitting "tabFocused → true" and "reset content focus" across
  two effects — the focus DOM-management effect runs first on the
  next render, sees stale focus state, and re-focuses the
  previously-active tile (and scrolls to it) before the reset
  effect commits. Always reset both `tabFocused` AND `focus` in
  the same back-handler call. See "Back-then-Down focus contract"
  above and the kids_back_focus.spec.ts regression suite.
* Per-row paint containment + transform on the parent stack —
  layer thrash. Either contain children OR transform parent, not
  both.
* `useDeferredValue` for window virtualization — broke layout
  consistency between placeholder rows and real rows. Render all
  rows; rely on `content-visibility: auto` + image priority for
  cost reduction.
* React.memo without ignoring callback identity — parent's fresh
  closures invalidate every memo'd child every render.
* `box-shadow` for focus rings on slow mode — paint cost. Use
  outline + outline-offset.
* TabPill rendered separately per page — animation broke because
  prev/next didn't share state. Now it's a single instance in
  KidsHome.
* Held-Enter (from a hold-to-open gesture) leaking into the
  newly-opened modal — modal was activating its first item. Fix:
  ignore `e.repeat` in modal keydown handlers AND defer first-button
  DOM focus until the opening key is released.

## Useful diagnostics

```bash
# Connect TV (one-time per session reboot)
./scripts/jb-tv connect 10.10.10.61

# Build kid app + Go binary, restart daemon
cd web/kids && npx vite build && cd ../.. && ./scripts/jb restart

# Force-stop + relaunch on TV (to pick up new bundle)
./scripts/jb-tv launch
# (or: adb -s 10.10.10.61:5555 shell am force-stop com.fisherevans.jellybean.debug && jb-tv launch)

# Tail kid client logs
adb logcat | grep -i webview  # WebView console messages

# Inspect WebView in Chrome devtools
./scripts/jb-tv inspect
# Then open chrome://inspect/#devices on the dev Mac.
```

## Where to read more

* `docs/original-product-idea.md` — product north star and
  rejected alternatives.
* `docs/auth-pivot-plan.md` — kid auth flow.
* `docs/device-profiles.md` — why the M-AT bitrate ceiling lives
  in localStorage on the device, not server-side.
