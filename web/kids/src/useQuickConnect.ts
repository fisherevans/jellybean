// Mirrored: keep web/kids/src/useQuickConnect.ts and
// web/admin/src/useQuickConnect.ts byte-identical (modulo imports). To be
// hoisted to web/shared/ once npm workspaces land (item #19/#3).
//
// useQuickConnect owns the Jellyfin Quick Connect state machine:
//
//   1. Probe /quickconnect/enabled and settle into "qc" or "password"
//      (or stay in "loading" until the probe lands).
//   2. On entering "qc" mode, kick a single /start to mint a code +
//      pairing id. StrictMode-safe: the startedRef flips true
//      synchronously before the await, so the second invocation in
//      dev's double-mount bails. unmountedRef gates late mutates from
//      the in-flight /start when the user flips to password mid-fetch.
//   3. While a pairing is live, poll /poll?id every POLL_INTERVAL_MS.
//      Terminal states: "expired" / 410 / 404 -> show "expired",
//      "authorized" -> hand the role-specific success payload to
//      onAuthorized, 403 -> surface a hook-supplied forbidden message
//      and clear the pairing. Transient errors are swallowed; the
//      next tick retries.
//
// Each app supplies its own fetchers (kid app talks to /api/kids/*,
// admin app talks to /api/auth/*) and a pickResult that pulls the
// success payload out of the poll response shape it cares about
// (LoginResponse for kids, User for admin).
import { useCallback, useEffect, useRef, useState } from "react";

const POLL_INTERVAL_MS = 3000;

export type Mode = "loading" | "qc" | "password";

export type QCStartResponse = {
    id: string;
    code: string;
    expiresAt: string;
};

// QuickConnectErrorKind classifies the four terminal poll outcomes
// each app's fetchers normalize to. "transient" lets the hook keep
// polling on networking blips without bailing the pairing.
export type QuickConnectErrorKind =
    | "expired"
    | "forbidden"
    | "transient"
    | "unavailable";

export class QuickConnectError extends Error {
    constructor(public kind: QuickConnectErrorKind, message?: string) {
        super(message ?? kind);
    }
}

export type QuickConnectFetchers<TPoll> = {
    enabled: () => Promise<{ enabled: boolean }>;
    start: () => Promise<QCStartResponse>;
    // poll resolves with the raw poll payload (the shape pickResult
    // reads from) or throws QuickConnectError on terminal/transient
    // failure. "expired" status lives in the resolved payload, not
    // the error path - see the kid + admin fetcher implementations.
    poll: (id: string) => Promise<TPoll>;
};

export type Options<TPoll, TResult> = {
    fetchers: QuickConnectFetchers<TPoll>;
    onAuthorized: (result: TResult) => void;
    // pickResult returns the success payload when the poll response
    // says authorized, else null. Returning null on a terminal "expired"
    // payload is also fine - the hook's terminalFromPoll handles that.
    pickResult: (poll: TPoll) => TResult | null;
    // terminalFromPoll lets the hook distinguish "expired" embedded
    // in a 200 body (Jellyfin's preferred shape) vs "authorized" /
    // "pending". Returns the kind to fold into the expired flag, or
    // null when the response should keep polling.
    terminalFromPoll: (poll: TPoll) => "expired" | null;
    // forbiddenMessage is what the hook surfaces via setError when a
    // 403 lands during polling. Each app phrases this differently.
    forbiddenMessage: string;
    // unavailableMessage is what the hook surfaces when /start itself
    // fails (network down, 5xx). Each app phrases this differently.
    unavailableMessage: (err: unknown) => string;
    // skip lets the caller short-circuit the entire hook (kid app's
    // dev-creds path skips QC altogether so the hash-injected creds
    // can auto-submit the password form without a stray /start).
    skip?: boolean;
};

export type UseQuickConnectResult = {
    mode: Mode;
    code: string | null;
    expired: boolean;
    error: string | null;
    setMode: (m: Mode) => void;
    setError: (msg: string | null) => void;
    restart: () => void;
};

export function useQuickConnect<TPoll, TResult>(
    opts: Options<TPoll, TResult>,
): UseQuickConnectResult {
    const {
        fetchers,
        onAuthorized,
        pickResult,
        terminalFromPoll,
        forbiddenMessage,
        unavailableMessage,
        skip,
    } = opts;

    const [mode, setMode] = useState<Mode>("loading");
    const [start, setStart] = useState<QCStartResponse | null>(null);
    const [expired, setExpired] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // unmountedRef gates the /start fetch's late callbacks: when the
    // user flips to password mid-fetch (or unmounts entirely), late
    // setStart / setError calls would land on a stale view. Same
    // pattern as the cancelled flag in the poll effect, scoped to the
    // hook's lifetime instead of one effect run.
    const unmountedRef = useRef(false);
    useEffect(() => {
        return () => {
            unmountedRef.current = true;
        };
    }, []);

    // startedRef tracks the most recent /start call. Set true when a
    // pairing is in-flight or already minted; flipped back to false
    // on terminal failure (expired / forbidden) so restart() can
    // mint a fresh one. The synchronous flip BEFORE the await is
    // what makes this StrictMode-safe; the second invocation of the
    // mount effect sees true and bails. Flipping order would mint
    // two codes per page load in dev.
    const startedRef = useRef(false);

    // Latest fetchers / callbacks captured in a ref so the polling
    // effect doesn't tear down + recreate its interval on every
    // render (the parent typically passes fresh closures).
    const fetchersRef = useRef(fetchers);
    const onAuthorizedRef = useRef(onAuthorized);
    const pickResultRef = useRef(pickResult);
    const terminalFromPollRef = useRef(terminalFromPoll);
    const forbiddenMessageRef = useRef(forbiddenMessage);
    const unavailableMessageRef = useRef(unavailableMessage);
    useEffect(() => {
        fetchersRef.current = fetchers;
        onAuthorizedRef.current = onAuthorized;
        pickResultRef.current = pickResult;
        terminalFromPollRef.current = terminalFromPoll;
        forbiddenMessageRef.current = forbiddenMessage;
        unavailableMessageRef.current = unavailableMessage;
    }, [
        fetchers,
        onAuthorized,
        pickResult,
        terminalFromPoll,
        forbiddenMessage,
        unavailableMessage,
    ]);

    // Probe QC support once. We default to QC when the server says
    // yes (saves password typing on a TV remote / phone keyboard).
    // Failures fall to password automatically; nothing to surface.
    useEffect(() => {
        if (skip) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await fetchersRef.current.enabled();
                if (cancelled) return;
                setMode(res.enabled ? "qc" : "password");
            } catch {
                if (!cancelled) setMode("password");
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [skip]);

    const startPairing = useCallback(async () => {
        setExpired(false);
        setError(null);
        try {
            const res = await fetchersRef.current.start();
            if (unmountedRef.current) return;
            setStart(res);
        } catch (err) {
            if (unmountedRef.current) return;
            startedRef.current = false;
            setError(unavailableMessageRef.current(err));
        }
    }, []);

    // Kick a single pairing whenever we enter qc mode without one.
    // The synchronous startedRef flip BEFORE the await is what makes
    // this StrictMode-safe: the second invocation of this effect
    // sees true and bails. Flipping the order mints two codes per
    // page load in dev.
    useEffect(() => {
        if (mode !== "qc") return;
        if (start || expired) return;
        if (startedRef.current) return;
        startedRef.current = true;
        void startPairing();
    }, [mode, start, expired, startPairing]);

    // Poll the live pairing. Stops on terminal state. Cadence matches
    // Jellyfin web's own poll loop; the backend caches the exchange
    // result so a duplicate poll between approval and navigation is
    // safe. Fires one tick immediately so a user who happened to
    // approve before the poll loop kicked in doesn't sit through a
    // full interval of "Waiting...".
    useEffect(() => {
        if (mode !== "qc" || !start) return;
        let cancelled = false;
        const tick = async () => {
            try {
                const res = await fetchersRef.current.poll(start.id);
                if (cancelled) return;
                const term = terminalFromPollRef.current(res);
                if (term === "expired") {
                    setExpired(true);
                    setStart(null);
                    startedRef.current = false;
                    return;
                }
                const picked = pickResultRef.current(res);
                if (picked) {
                    onAuthorizedRef.current(picked);
                }
            } catch (err) {
                if (cancelled) return;
                if (err instanceof QuickConnectError) {
                    if (err.kind === "expired") {
                        setExpired(true);
                        setStart(null);
                        startedRef.current = false;
                        return;
                    }
                    if (err.kind === "forbidden") {
                        setError(forbiddenMessageRef.current);
                        setExpired(true);
                        setStart(null);
                        startedRef.current = false;
                        return;
                    }
                }
                // Transient (or unrecognized): next tick retries.
            }
        };
        const id = window.setInterval(tick, POLL_INTERVAL_MS);
        void tick();
        return () => {
            cancelled = true;
            window.clearInterval(id);
        };
    }, [mode, start]);

    const restart = useCallback(() => {
        setExpired(false);
        setStart(null);
        startedRef.current = false;
        void startPairing();
    }, [startPairing]);

    return {
        mode,
        code: start?.code ?? null,
        expired,
        error,
        setMode,
        setError,
        restart,
    };
}
