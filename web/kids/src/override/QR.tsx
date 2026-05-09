// QrStage: shows a scannable QR code so the parent can hop over
// to /admin to deep-edit the focused item. The image is rendered
// by api.qrserver.com (no client-side QR encoder dep) — the URL
// itself is generated upstream and passed in.

import { BackLink, ModalShell } from "./shell";
import type { StageCtx } from "./types";

type Props = {
    ctx: StageCtx;
    url: string;
    editTargetName: string;
};

export function QrStage({ ctx, url, editTargetName }: Props) {
    return (
        <ModalShell title="Open on your phone">
            <p className="muted">
                Scan to manage "{editTargetName}" from a browser.
            </p>
            <div className="override-qr-wrap">
                <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(url)}`}
                    alt={`QR code linking to ${url}`}
                    width={240}
                    height={240}
                />
            </div>
            <code className="override-qr-url">{url}</code>
            <BackLink autoFocus onActivate={ctx.pop} />
        </ModalShell>
    );
}
