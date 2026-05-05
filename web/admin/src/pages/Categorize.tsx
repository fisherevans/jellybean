import { Link, useLocation } from "react-router-dom";
import Swipe from "./Swipe";
import Bulk from "./Bulk";

// Wraps the two categorization workflows. /categorize and /swipe both
// land on the swipe view; /bulk lands on the grid view. The header
// reads as a heading + small switcher link so it doesn't look like a
// pair of equal-weight tabs.

export default function Categorize() {
    const location = useLocation();
    const isBulk = location.pathname === "/bulk";
    return (
        <div className="categorize-shell">
            <div className="categorize-header">
                {isBulk ? (
                    <>
                        <h1>Bulk categorize</h1>
                        <Link to="/swipe" className="categorize-switch">
                            ← Back to swipe
                        </Link>
                    </>
                ) : (
                    <>
                        <h1>Swipe</h1>
                        <Link to="/bulk" className="categorize-switch">
                            Categorize in bulk →
                        </Link>
                    </>
                )}
            </div>
            {isBulk ? <Bulk /> : <Swipe />}
        </div>
    );
}
