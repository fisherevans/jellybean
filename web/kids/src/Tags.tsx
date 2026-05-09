import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
    getSession,
    imageAuthSuffix,
    type Session,
} from "./auth";
import { useKidsHome } from "./KidsHome";
import { useProgressiveBack } from "./useProgressiveBack";
import { useStackScroll } from "./useStackScroll";
import { TAG_ICONS, isTagIconName } from "jellybean-shared";
import { useHomeTabFocus } from "./useHomeTabFocus";
import { useItemHiddenEvent } from "./itemHidden";
import { useKidsResource } from "./useKidsResource";
import { sessionCache } from "./kidsCache";

// Tags is the kid's tag-browse landing page. Fetches /api/kids/tags
// and renders one large landscape card per tag - title, description,
// and a mini strip of preview posters. The kid can D-pad up/down
// to step between cards. Activating a card (Enter) is reserved for
// a future tag-detail view; currently it nav's to /watch on the
// first preview item if any.

type PreviewItem = {
    id: string;
    name: string;
    type: string;
    imageTags?: { Primary?: string };
};

type TagWithPreview = {
    id: number;
    name: string;
    description: string;
    icon?: string;
    itemCount: number;
    items: PreviewItem[];
};

type TagsResponse = {
    tags: TagWithPreview[];
};

export default function Tags() {
    const nav = useNavigate();
    const [searchParams] = useSearchParams();
    const [session] = useState<Session | null>(() => getSession());
    const adminProfileId = searchParams.get("profileId");
    const playSuffix = searchParams.toString()
        ? `?${searchParams.toString()}`
        : "";
    // sessionStorage cache: render the previous response (including
    // its randomized preview items) synchronously on mount and
    // skip refetching while the cache is present. This keeps the
    // tag previews stable across visits - the kid backs out of a
    // tag detail page and sees the same poster strip they saw
    // before, not a new random shuffle. Cache is invalidated by
    // the menu's "Refresh from server" action (which clears
    // sessionStorage + reloads).
    const cacheKey = `jellybean.kids.tags.cache.${adminProfileId ?? "kid"}`;
    const focusIdxKey = `jellybean.kids.tags.focusIdx.${adminProfileId ?? "kid"}`;
    const tagsURL = useMemo(() => {
        if (!session && !adminProfileId) return null;
        const url = new URL("/api/kids/tags", window.location.origin);
        if (adminProfileId) url.searchParams.set("profileId", adminProfileId);
        return url.toString();
    }, [session, adminProfileId]);
    const cache = useMemo(() => sessionCache<TagsResponse>(), []);
    const { data: fetchedData, error } = useKidsResource<TagsResponse>({
        url: tagsURL,
        cache,
        cacheKey,
        skipFetchWhenCacheHit: true,
    });
    const [data, setData] = useState<TagsResponse | null>(fetchedData);
    useEffect(() => {
        if (fetchedData) setData(fetchedData);
    }, [fetchedData]);
    // Transform-based scroll - same rationale as Library. The
    // stack ref attaches to the .kids-stack wrapper; the hook
    // animates translate3d on it instead of writing window.scrollTo
    // (which retriggered a multi-second repaint on the kid TV).
    const stack = useStackScroll();
    const homeCtx = useKidsHome();

    // Restore the focused tag index from sessionStorage so the kid
    // returning from /tags/:id lands back on the tag they entered.
    // useHomeTabFocus owns the back-then-down reset (focusIdx → 0,
    // tab nav re-engages) and the tabFocused → true scroll-to-top +
    // blur effect; here we just hand it the persisted starting
    // value and the "first card" reset target.
    const {
        focus: focusIdx,
        setFocus: setFocusIdx,
        tabFocused,
        setTabFocused,
        handleBack,
    } = useHomeTabFocus<number>({
        initialFocus: (() => {
            try {
                const v = sessionStorage.getItem(focusIdxKey);
                if (v !== null) {
                    const n = Number(v);
                    if (Number.isFinite(n) && n >= 0) return n;
                }
            } catch {
                /* ignore */
            }
            return 0;
        })(),
        getFirstContentSlot: () => 0,
        scrollToTop: () => stack.setStackY(0, true),
        tabNav: {
            tabFocused: homeCtx.tabFocused,
            setTabFocused: homeCtx.setTabFocused,
        },
    });
    // Persist focusIdx so it survives a remount.
    useEffect(() => {
        try {
            sessionStorage.setItem(focusIdxKey, String(focusIdx));
        } catch {
            /* ignore */
        }
    }, [focusIdx, focusIdxKey]);

    // Parent hid an item: prune it from every tag's preview strip
    // and decrement the per-tag count. We rewrite the
    // sessionStorage cache so the next visit (which uses the cache
    // synchronously) doesn't briefly resurrect the dead poster
    // before a refetch lands. Itemcount goes to max(0, n-1) per
    // tag the item appeared in; if the item was actually in N tags
    // we'd need a server tag membership lookup to be exact, but
    // every tag whose preview included the item definitely
    // contained it, so the local decrement is correct for those.
    useItemHiddenEvent((hiddenId) => {
        setData((prev) => {
            if (!prev) return prev;
            const next: TagsResponse = {
                tags: prev.tags.map((tag) => {
                    const filtered = tag.items.filter(
                        (it) => it.id !== hiddenId,
                    );
                    if (filtered.length === tag.items.length) return tag;
                    return {
                        ...tag,
                        items: filtered,
                        itemCount: Math.max(0, tag.itemCount - 1),
                    };
                }),
            };
            cache.write(cacheKey, next);
            return next;
        });
    });

    // Helper: navigate to a tag's detail page. Sets a one-shot
    // flag so when the kid backs out of TagDetail and lands here,
    // we engage the saved focusIdx visually (setTabFocused(false))
    // instead of defaulting to tab-nav focus. Without the flag,
    // navigating Library -> Tags would also setTabFocused(false),
    // which is wrong (tab nav navigation should land on the tab).
    const navToTagDetail = useCallback(
        (tagId: number) => {
            try {
                sessionStorage.setItem(
                    "jellybean.kids.tags.expectBackFromDetail",
                    "1",
                );
            } catch {
                /* ignore */
            }
            nav(`/tags/${tagId}${playSuffix}`);
        },
        [nav, playSuffix],
    );

    // Snap to top on mount so a stale animator left behind by a
    // previous page can't keep scrolling here.
    useLayoutEffect(() => {
        stack.setStackY(0, true);
        // stack methods are stable; safe to omit from deps.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Consume the "back from detail" flag on mount: drops tab nav
    // focus so the persisted focusIdx-driven card highlight kicks
    // in immediately. The kid's eye returns to the same card they
    // were on before diving into a tag.
    useEffect(() => {
        let expecting = false;
        try {
            const v = sessionStorage.getItem(
                "jellybean.kids.tags.expectBackFromDetail",
            );
            expecting = v === "1";
            sessionStorage.removeItem(
                "jellybean.kids.tags.expectBackFromDetail",
            );
        } catch {
            /* ignore */
        }
        if (expecting) {
            setTabFocused(false);
        }
        // Run once on mount only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const [columns, setColumns] = useState(1);
    const cardRefs = useRef<(HTMLButtonElement | null)[]>([]);
    const listRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!session && !adminProfileId) {
            nav("/login", { replace: true });
        }
    }, [session, adminProfileId, nav]);

    // Tell the splash gate we have content rendered.
    useEffect(() => {
        if (data) {
            window.dispatchEvent(new Event("jellybean:ready"));
        }
    }, [data]);

    // Imperative DOM focus + scroll-into-view on the active card.
    // First card pins to top so the tab nav is visible alongside;
    // subsequent cards center in the viewport via the smooth-scroll
    // animator. preventScroll=true on .focus() so we own all
    // scrolls (browser auto-scroll into view tends to over-shoot
    // and fights the smooth animator on rapid arrow presses).
    useEffect(() => {
        if (tabFocused) return;
        const el = cardRefs.current[focusIdx];
        if (!el) return;
        el.focus({ preventScroll: true });
        if (focusIdx === 0) {
            stack.scrollToTop();
        } else {
            stack.scrollToCenter(el);
        }
    }, [focusIdx, tabFocused, stack]);

    // useHomeTabFocus owns the back-then-down reset (focusIdx → 0
    // + tab nav re-engages) and the tabFocused → true scroll-to-top
    // + blur effect. The expectBackFromDetail path (setTabFocused(false)
    // on mount with persisted focusIdx) isn't affected: TagDetail
    // navigates to /tags directly and never invokes this back handler.
    // See web/kids/CLAUDE.md ("Back-then-Down focus contract").
    useProgressiveBack(handleBack);

    // Clamp focusIdx in case the persisted value is out of range
    // for the current data (e.g. tags removed on the server while
    // we had a saved index).
    useEffect(() => {
        const tagsLen = data?.tags.length ?? 0;
        if (tagsLen > 0 && focusIdx >= tagsLen) {
            setFocusIdx(tagsLen - 1);
        }
    }, [data, focusIdx]);

    // Re-measure column count on layout changes (mount, data load,
    // resize). Same trick as Library's useGridColumns - count
    // children that share the first child's offsetTop.
    useEffect(() => {
        const update = () => {
            const list = listRef.current;
            if (!list) return;
            const first = list.firstElementChild as HTMLElement | null;
            if (!first) return;
            const firstTop = first.offsetTop;
            let count = 0;
            for (const c of Array.from(list.children) as HTMLElement[]) {
                if (Math.abs(c.offsetTop - firstTop) > 1) break;
                count++;
            }
            if (count > 0) setColumns(count);
        };
        update();
        window.addEventListener("resize", update);
        return () => window.removeEventListener("resize", update);
    }, [data]);

    useEffect(() => {
        if (tabFocused) return;
        const onKey = (e: KeyboardEvent) => {
            if (
                e.key !== "ArrowDown" &&
                e.key !== "ArrowUp" &&
                e.key !== "ArrowLeft" &&
                e.key !== "ArrowRight" &&
                e.key !== "Enter" &&
                e.key !== " "
            ) {
                return;
            }
            e.preventDefault();
            if (e.repeat) return;
            const tagsLen = data?.tags.length ?? 0;
            if (tagsLen === 0) return;
            const cols = Math.max(1, columns);
            if (e.key === "ArrowLeft") {
                if (focusIdx % cols > 0) {
                    setFocusIdx((i) => i - 1);
                }
                return;
            }
            if (e.key === "ArrowRight") {
                if (
                    (focusIdx + 1) % cols !== 0 &&
                    focusIdx + 1 < tagsLen
                ) {
                    setFocusIdx((i) => i + 1);
                }
                return;
            }
            if (e.key === "ArrowDown") {
                const next = focusIdx + cols;
                if (next < tagsLen) {
                    setFocusIdx(next);
                } else if (focusIdx + 1 < tagsLen) {
                    // Allow clamping to last item if a partial last
                    // row exists (Down from a card whose column
                    // doesn't have a card directly below).
                    setFocusIdx(tagsLen - 1);
                }
                return;
            }
            if (e.key === "ArrowUp") {
                if (focusIdx >= cols) {
                    setFocusIdx((i) => i - cols);
                } else {
                    setTabFocused(true);
                }
                return;
            }
            if (e.key === "Enter" || e.key === " ") {
                const tag = data?.tags[focusIdx];
                if (!tag) return;
                navToTagDetail(tag.id);
                return;
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [tabFocused, focusIdx, columns, data, setTabFocused, navToTagDetail]);

    if (error) {
        return (
            <div className="kids-page kids-tags">
                <div className="kids-tags-empty">
                    <h1>Tags</h1>
                    <p>Couldn't load tags ({error}).</p>
                </div>
            </div>
        );
    }
    if (!data) {
        return (
            <div className="kids-page kids-tags">
                <div className="kids-tags-empty">
                    <h1>Tags</h1>
                    <p>Loading…</p>
                </div>
            </div>
        );
    }
    if (data.tags.length === 0) {
        return (
            <div className="kids-page kids-tags">
                <div className="kids-tags-empty">
                    <h1>Tags</h1>
                    <p>No tags yet. Ask a grown-up to add some.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="kids-page kids-tags">
            <div ref={stack.stackRef} className="kids-stack kids-tags-stack">
            <div className="kids-tags-list" ref={listRef}>
                {data.tags.map((tag, i) => {
                    const isFocused = !tabFocused && focusIdx === i;
                    return (
                        <button
                            key={tag.id}
                            type="button"
                            ref={(el) => (cardRefs.current[i] = el)}
                            className={`kids-tag-card ${isFocused ? "focused" : ""}`}
                            tabIndex={isFocused ? 0 : -1}
                            onClick={() => {
                                setFocusIdx(i);
                                setTabFocused(false);
                                navToTagDetail(tag.id);
                            }}
                            onFocus={() => {
                                setFocusIdx(i);
                                setTabFocused(false);
                            }}
                        >
                            <div className="kids-tag-card-body">
                                <h2 className="kids-tag-card-title">
                                    <TagIcon name={tag.icon} />
                                    {tag.name}
                                </h2>
                                {tag.description && (
                                    <p className="kids-tag-card-desc">
                                        {tag.description}
                                    </p>
                                )}
                                <p className="kids-tag-card-count">
                                    {tag.itemCount}{" "}
                                    {tag.itemCount === 1 ? "item" : "items"}
                                </p>
                            </div>
                            <div className="kids-tag-card-preview">
                                {tag.items.length === 0 ? (
                                    <p className="kids-tag-card-empty">
                                        No items yet.
                                    </p>
                                ) : (
                                    tag.items.map((it) => {
                                        const tagAttr = it.imageTags?.Primary ?? "";
                                        const src = `/api/kids/items/${encodeURIComponent(it.id)}/image?type=Primary&width=160${
                                            tagAttr
                                                ? `&tag=${encodeURIComponent(tagAttr)}`
                                                : ""
                                        }${imageAuthSuffix()}`;
                                        return (
                                            <div
                                                key={it.id}
                                                className="kids-tag-card-poster"
                                                aria-label={it.name}
                                            >
                                                {tagAttr ? (
                                                    <img
                                                        src={src}
                                                        alt={it.name}
                                                        loading="lazy"
                                                        decoding="async"
                                                    />
                                                ) : (
                                                    <span className="kids-tag-card-poster-fallback">
                                                        {it.name}
                                                    </span>
                                                )}
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                        </button>
                    );
                })}
            </div>
            </div>
        </div>
    );
}

// TagIcon resolves the tag's stored icon name from the curated
// allow-list. Unknown / empty names render nothing - mirrors the
// detail page's resolver, so admin-set icons that we later remove
// from the allow-list don't crash this view either.
function TagIcon({ name }: { name?: string }) {
    if (!name || !isTagIconName(name)) return null;
    const Icon = TAG_ICONS[name];
    return (
        <Icon weight="fill" className="kids-tag-card-title-icon" aria-hidden />
    );
}
