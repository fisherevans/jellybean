// HideConfirmStage: confirm before mutating the kid's library.
// Posts /api/kids/override/items/:id/hide and emits a
// "jellybean:item-hidden" CustomEvent so the active page evicts
// the item from in-memory state without a full refetch.

import { useState } from "react";
import { authHeaders } from "../auth";
import { ActionList, ModalShell } from "./shell";
import type { StageCtx } from "./types";

type Props = {
    ctx: StageCtx;
    token: string;
    itemId: string;
    itemName: string;
    itemType: string;
};

export function HideConfirmStage({
    ctx,
    token,
    itemId,
    itemName,
    itemType,
}: Props) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    async function confirm() {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(
                `/api/kids/override/items/${encodeURIComponent(itemId)}/hide${ctx.previewQuery}`,
                {
                    method: "POST",
                    credentials: "same-origin",
                    headers: {
                        ...authHeaders(),
                        "X-Override-Token": token,
                    },
                },
            );
            if (!res.ok) throw new Error(`${res.status}`);
            // Tell the active page to evict the item from its
            // in-memory state + caches without a full refetch
            // (which would re-randomize rows). Pages listen via
            // useItemHiddenEvent below.
            window.dispatchEvent(
                new CustomEvent("jellybean:item-hidden", {
                    detail: { itemId },
                }),
            );
            ctx.replaceTop({
                kind: "done",
                message: `Hidden ${itemName} from this kid's library.`,
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : "failed");
        } finally {
            setBusy(false);
        }
    }
    return (
        <ModalShell
            title={`Hide ${itemType.toLowerCase()}?`}
            subtitle={itemName}
        >
            <p className="muted">
                {itemName} won't appear in this kid's library until a parent
                un-hides it from /admin.
            </p>
            {error && <div className="error">{error}</div>}
            <ActionList
                items={[
                    {
                        key: "cancel",
                        label: "Cancel",
                        onActivate: ctx.pop,
                        autoFocus: true,
                    },
                    {
                        key: "confirm",
                        label: busy ? "Hiding…" : "Confirm hide",
                        onActivate: confirm,
                        disabled: busy,
                        danger: true,
                    },
                ]}
            />
        </ModalShell>
    );
}
