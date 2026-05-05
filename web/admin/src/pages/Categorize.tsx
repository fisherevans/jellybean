import { Link, useLocation } from "react-router-dom";
import Swipe from "./Swipe";
import Bulk from "./Bulk";

// Wraps the two categorization workflows under one nav item. /swipe
// stays as the default entry so existing muscle memory holds; /bulk
// continues to work as a direct link. The toggle at the top of the
// page swaps between them.

export default function Categorize() {
    const location = useLocation();
    const isBulk = location.pathname === "/bulk";
    return (
        <div className="categorize-shell">
            <div className="categorize-modes">
                <Link
                    to="/swipe"
                    className={`pill-toggle ${!isBulk ? "active" : ""}`}
                    aria-pressed={!isBulk}
                >
                    Swipe one at a time
                </Link>
                <Link
                    to="/bulk"
                    className={`pill-toggle ${isBulk ? "active" : ""}`}
                    aria-pressed={isBulk}
                >
                    Bulk
                </Link>
            </div>
            {isBulk ? <Bulk /> : <Swipe />}
        </div>
    );
}
