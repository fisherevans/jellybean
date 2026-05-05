// Live preview of dim + red-shift effects using a CSS filter on a
// gradient-rendered "TV". Pure visual preview - the actual kid SPA
// applies the same filter expression at the document root.

type Props = {
    dimPercent: number;
    redShiftPercent: number;
};

export default function ViewingPreview({ dimPercent, redShiftPercent }: Props) {
    const filter = buildFilter(dimPercent, redShiftPercent);
    return (
        <div className="viewing-preview">
            <div className="viewing-preview-label">Preview</div>
            <div className="viewing-preview-tv" aria-hidden>
                <div
                    className="viewing-preview-bezel"
                    style={{ filter }}
                >
                    <div className="viewing-preview-scene">
                        <div className="vp-sky" />
                        <div className="vp-sun" />
                        <div className="vp-mountain vp-mountain-back" />
                        <div className="vp-mountain vp-mountain-front" />
                        <div className="vp-foreground" />
                        <div className="vp-tree vp-tree-1" />
                        <div className="vp-tree vp-tree-2" />
                    </div>
                </div>
                <div className="viewing-preview-stand" />
            </div>
            <div className="viewing-preview-summary">
                {dimPercent === 0 && redShiftPercent === 0
                    ? "No effect applied."
                    : describe(dimPercent, redShiftPercent)}
            </div>
        </div>
    );
}

export function buildFilter(dim: number, redShift: number): string {
    const brightness = 1 - dim / 100;
    const sepia = redShift / 100;
    const hueRotate = -10 * (redShift / 100);
    return `brightness(${brightness}) sepia(${sepia}) hue-rotate(${hueRotate}deg)`;
}

function describe(dim: number, red: number): string {
    const parts: string[] = [];
    if (dim > 0) parts.push(`${dim}% darker`);
    if (red > 0) parts.push(`${red}% warmer`);
    return parts.join(" · ");
}
