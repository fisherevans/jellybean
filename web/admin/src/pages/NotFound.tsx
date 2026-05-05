import { Link, useLocation } from "react-router-dom";

// Catch-all admin route. Renders inside the regular Layout shell so
// the user keeps the top nav + sign-out + profile picker - just the
// content area shows the 404 message.

export default function NotFound() {
    const location = useLocation();
    return (
        <div className="not-found">
            <div className="not-found-code">404</div>
            <h1>Page not found</h1>
            <p className="muted">
                Nothing's wired up for{" "}
                <code>{location.pathname}</code>. The link might be stale or
                the path may have moved during the recent /manage rename.
            </p>
            <div className="not-found-links">
                <Link to="/" className="primary-link">
                    ← Home
                </Link>
                <Link to="/admin" className="muted-link">
                    Settings
                </Link>
                <Link to="/categorize" className="muted-link">
                    Categorize
                </Link>
                <Link to="/browse" className="muted-link">
                    Browse
                </Link>
            </div>
        </div>
    );
}
