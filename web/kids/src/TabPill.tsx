import { useNavigate } from "react-router-dom";
import { Books, House } from "@phosphor-icons/react";

// TabPill is the shared top-of-page nav. Three slots:
//   - Browse + Library (centered, equal spacing) for tab switching
//   - Menu (floated right) for sign-out / swap-users / exit-app
//
// The pill participates in D-pad focus on the kid TV. The parent
// page owns the focus state machine and tells the pill which slot
// (if any) is currently focused via `focusedIndex`. Indexes:
//   0 = Browse, 1 = Library, 2 = Menu
//
// Parent registers refs for each button via `tabRef` so its focus
// effect can imperatively focus the underlying DOM element when
// the state machine parks here.

type Tab = "browse" | "library";

type Props = {
    active: Tab;
    // pass-through search params keep admin-preview links working
    // (?profileId=N stays as the user toggles between tabs)
    search?: string;
    // Index of the focused slot (0 = Browse, 1 = Library, 2 = Menu)
    // when the parent's focus state has parked on the pill. null
    // means focus is elsewhere; no slot gets tabIndex=0 in that case.
    focusedIndex?: number | null;
    // Register a ref for each slot. Parent uses these to
    // imperatively focus the slot when its focus model lands here.
    tabRef?: (i: number, el: HTMLButtonElement | null) => void;
    // Open the menu modal. Parent owns modal state.
    onOpenMenu?: () => void;
};

export const TAB_SLOT_BROWSE = 0;
export const TAB_SLOT_LIBRARY = 1;
export const TAB_SLOT_MENU = 2;
export const TAB_SLOT_COUNT = 3;

export function tabHref(tab: Tab, search = ""): string {
    return `/${tab}${search}`;
}

export default function TabPill({
    active,
    search = "",
    focusedIndex,
    tabRef,
    onOpenMenu,
}: Props) {
    const nav = useNavigate();
    return (
        <nav className="kids-tabpill" aria-label="Top-level navigation">
            <div className="kids-tabpill-spacer" aria-hidden />
            <div
                className={`kids-tabpill-tabs is-${active}`}
                data-active={active}
            >
                <button
                    type="button"
                    ref={(el) => tabRef?.(TAB_SLOT_BROWSE, el)}
                    className={`kids-tabpill-btn ${active === "browse" ? "active" : ""} ${
                        focusedIndex === TAB_SLOT_BROWSE ? "focused" : ""
                    }`}
                    onClick={() => nav(tabHref("browse", search))}
                    aria-current={active === "browse" ? "page" : undefined}
                    data-tab-pill="browse"
                    tabIndex={focusedIndex === TAB_SLOT_BROWSE ? 0 : -1}
                >
                    <House
                        weight="fill"
                        className="kids-tabpill-icon kids-tabpill-icon-browse"
                        aria-hidden
                    />
                    <span className="kids-tabpill-btn-label">Browse</span>
                </button>
                <button
                    type="button"
                    ref={(el) => tabRef?.(TAB_SLOT_LIBRARY, el)}
                    className={`kids-tabpill-btn ${active === "library" ? "active" : ""} ${
                        focusedIndex === TAB_SLOT_LIBRARY ? "focused" : ""
                    }`}
                    onClick={() => nav(tabHref("library", search))}
                    aria-current={active === "library" ? "page" : undefined}
                    data-tab-pill="library"
                    tabIndex={focusedIndex === TAB_SLOT_LIBRARY ? 0 : -1}
                >
                    <Books
                        weight="fill"
                        className="kids-tabpill-icon kids-tabpill-icon-library"
                        aria-hidden
                    />
                    <span className="kids-tabpill-btn-label">Library</span>
                </button>
            </div>
            <div className="kids-tabpill-side">
                <button
                    type="button"
                    ref={(el) => tabRef?.(TAB_SLOT_MENU, el)}
                    className={`kids-tabpill-menu ${
                        focusedIndex === TAB_SLOT_MENU ? "focused expanded" : ""
                    }`}
                    onClick={() => onOpenMenu?.()}
                    aria-label="Menu"
                    data-tab-pill="menu"
                    tabIndex={focusedIndex === TAB_SLOT_MENU ? 0 : -1}
                >
                    <img
                        src="/player/jellybean-kids.png"
                        alt=""
                        className="kids-tabpill-menu-icon"
                        aria-hidden
                    />
                    <span className="kids-tabpill-menu-label">Menu</span>
                </button>
            </div>
        </nav>
    );
}
