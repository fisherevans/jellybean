// Spinner is a small CSS-only loading indicator used wherever a page has
// to wait on a slow Jellyfin call. Pair it with a label so the reason for
// the wait is obvious.
//
// Sized via the `size` prop (px) so callers can use it inline next to
// text or as a hero centerpiece. No timeout / progress affordance: most
// of these waits are bounded by Jellyfin response times and the user
// just wants confirmation that something is happening.

type Props = {
    size?: number;
    label?: string;
    block?: boolean; // when true, lays out as a centered block with label below
};

export default function Spinner({ size = 28, label, block }: Props) {
    if (block) {
        return (
            <div className="spinner-block">
                <div
                    className="spinner"
                    style={{ width: size, height: size, borderWidth: Math.max(2, size / 10) }}
                    role="status"
                    aria-label={label ?? "Loading"}
                />
                {label && <p className="muted spinner-label">{label}</p>}
            </div>
        );
    }
    return (
        <span className="spinner-inline">
            <span
                className="spinner"
                style={{ width: size, height: size, borderWidth: Math.max(2, size / 10) }}
                role="status"
                aria-label={label ?? "Loading"}
            />
            {label && <span className="muted">{label}</span>}
        </span>
    );
}
