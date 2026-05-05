// Live preview of dim + red-shift effects using a CSS filter on a
// real photo (Muppets, supplied as the preview reference). Pure
// visual preview - the kid SPA applies the same filter expression
// at the document root.

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
                <div className="viewing-preview-bezel" style={{ filter }}>
                    <img
                        src="/manage/viewing-preview.jpg"
                        alt=""
                        className="viewing-preview-img"
                    />
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
    // Dim is straightforward: linear brightness reduction.
    const brightness = 1 - dim / 100;
    // Red shift = warmer image, similar to f.lux / Night Shift. The
    // CSS filter pipeline doesn't have a "color temperature" knob,
    // so we build it from primitives:
    //   - hue-rotate(-15deg) at 100% nudges blues toward red
    //   - sepia(0.35) at 100% adds an amber tint
    //   - saturate(1.2) at 100% keeps the image colourful instead
    //     of going gray-amber the way pure sepia does
    // The intermediate values scale linearly so 0% is no change and
    // 100% is the full warm shift. Same expression goes onto the kid
    // SPA's <html> element when the kid TV is in this mode, so what
    // the admin sees here is what the kid sees.
    const r = redShift / 100;
    const hueRotate = -15 * r;
    const sepia = 0.35 * r;
    const saturate = 1 + 0.2 * r;
    return `brightness(${brightness}) sepia(${sepia}) hue-rotate(${hueRotate}deg) saturate(${saturate})`;
}

function describe(dim: number, red: number): string {
    const parts: string[] = [];
    if (dim > 0) parts.push(`${dim}% darker`);
    if (red > 0) parts.push(`${red}% warmer`);
    return parts.join(" · ");
}
