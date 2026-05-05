// Live preview of dim + warm-tint effects using a CSS filter on a
// real photo. The warm effect targets macOS Night Shift fidelity at
// 100%: orange-tinted with the blue channel substantially suppressed.
//
// The filter pipeline alone can't actually attenuate a single channel
// (CSS filter has sepia/saturate/hue-rotate/contrast, no per-channel
// matrix). To get the "blue filtered out" feel we stack a multiply-
// blended orange overlay on top of the image - multiply with rgb
// (255, 130, 40) preserves red, halves green, and chops blue to ~16%.
// The overlay's alpha scales with warm intensity so 0% is identity
// and 100% is full Night Shift.
//
// The kid SPA's eventual M12 implementation should mirror this
// structure: <video> gets the filter, and a sibling div with the
// multiply-blend overlay sits on top inside a wrapper.

type Props = {
    dimPercent: number;
    redShiftPercent: number;
};

export default function ViewingPreview({ dimPercent, redShiftPercent }: Props) {
    const dimFilter = buildDimFilter(dimPercent);
    const warmFilter = buildWarmFilter(redShiftPercent);
    const overlayStyle = buildWarmOverlay(redShiftPercent);
    return (
        <div className="viewing-preview">
            <div className="viewing-preview-label">Preview</div>
            <div className="viewing-preview-tv" aria-hidden>
                <div
                    className="viewing-preview-bezel"
                    style={{ filter: dimFilter }}
                >
                    <div className="viewing-preview-frame">
                        <img
                            src="/manage/viewing-preview.jpg"
                            alt=""
                            className="viewing-preview-img"
                            style={{ filter: warmFilter }}
                        />
                        <div
                            className="viewing-preview-warm-overlay"
                            style={overlayStyle}
                            aria-hidden
                        />
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

// buildDimFilter just clamps the brightness multiplier. Decoupled
// from warm so the two adjustments don't interfere.
export function buildDimFilter(dim: number): string {
    const brightness = 1 - dim / 100;
    return `brightness(${brightness})`;
}

// buildWarmFilter is the per-image filter half of the Night Shift
// approximation: aggressive sepia + saturate + hue-rotate. The
// multiply overlay (buildWarmOverlay) is the other half and is what
// actually suppresses the blue channel.
export function buildWarmFilter(redShift: number): string {
    const r = clamp01(redShift / 100);
    const sepia = 0.7 * r;
    const saturate = 1 + 1.3 * r;
    const hueRotate = -20 * r;
    const contrast = 1 + 0.05 * r;
    return `sepia(${sepia}) saturate(${saturate}) hue-rotate(${hueRotate}deg) contrast(${contrast})`;
}

// buildWarmOverlay returns the inline style for the multiply-blended
// orange layer. The color is fixed; alpha (via opacity) scales with
// warm intensity. 0.42 cap at r=1 keeps natural colors recognisable
// (Kermit still looks like Kermit, Miss Piggy's pink still reads as
// pink) while still chopping enough blue to feel like Night Shift.
// Bumping past ~0.5 turns everything visibly orange.
export function buildWarmOverlay(redShift: number): {
    background: string;
    mixBlendMode: "multiply";
    opacity: number;
} {
    const r = clamp01(redShift / 100);
    return {
        background: "rgb(255, 140, 55)",
        mixBlendMode: "multiply",
        opacity: r * 0.42,
    };
}

// buildFilter is kept around for any caller that wants the legacy
// single-string filter expression (e.g. tests, or a future kid-side
// implementation that can't add an overlay element). The single-
// filter version is less faithful to Night Shift but doesn't need a
// wrapper element.
export function buildFilter(dim: number, redShift: number): string {
    const r = clamp01(redShift / 100);
    return `${buildDimFilter(dim)} sepia(${0.7 * r}) saturate(${1 + 1.3 * r}) hue-rotate(${-20 * r}deg) contrast(${1 + 0.05 * r})`;
}

function clamp01(x: number): number {
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
}

function describe(dim: number, red: number): string {
    const parts: string[] = [];
    if (dim > 0) parts.push(`${dim}% darker`);
    if (red > 0) parts.push(`${red}% warmer`);
    return parts.join(" · ");
}
