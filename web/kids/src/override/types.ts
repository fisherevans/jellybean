// Shared types for the M9 adult-override modal split. The host
// (OverrideModal.tsx) owns the stage stack; per-stage files render
// the top-of-stack stage and use StageCtx callbacks to push / pop /
// replace as needed.

export type Tag = { id: number; name: string };

// Stage is the discriminated union driving the stack. Adding a
// stage means adding a kind here, a render branch in the host, and
// (typically) a per-stage file under web/kids/src/override/.
export type Stage =
    | { kind: "pin" }
    | { kind: "menu"; token: string }
    | { kind: "tags"; token: string }
    | { kind: "hideConfirm"; token: string }
    | { kind: "contentTime"; token: string }
    | { kind: "globalTime"; token: string }
    | { kind: "modeAction"; token: string }
    | { kind: "modePicker"; token: string }
    | {
          kind: "modeDuration";
          token: string;
          intent: "set" | "disable";
          modeId?: number;
          modeName?: string;
      }
    | { kind: "dimSetup"; token: string }
    | { kind: "warmSetup"; token: string }
    | { kind: "bodyBreaks"; token: string }
    | { kind: "autoOff"; token: string }
    | { kind: "autoOffShift"; token: string }
    | { kind: "autoOffOneTime"; token: string }
    | { kind: "qr"; token: string; url: string }
    | { kind: "error"; message: string }
    | { kind: "done"; message: string };

// StageCtx is the navigation handle every stage receives. It hides
// the stack representation from per-stage files so they can't (and
// don't need to) reach into host state.
export type StageCtx = {
    push: (s: Stage) => void;
    pop: () => void;
    replaceTop: (s: Stage) => void;
    close: () => void;
    /** Admin preview query (?profileId=... or ?kidId=...) appended
     *  to every override fetch so the server acts as the right kid
     *  when no kid bearer is present. Empty string when not in
     *  preview mode. */
    previewQuery: string;
};
