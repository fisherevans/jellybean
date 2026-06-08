# Implementation roadmap

Authoritative order for working through M5-M17. Milestone numbers are
sticky labels (assigned in scoping order); this doc is the actual
sequence. GitHub issue bodies have "Depends on" notes for
informational dependency tracking, but the ordering decision lives
here.

## Sequence

```
1.  M5    Finish TV deployment            (Skyworth sideload + player transport)
2.  M-AT  Device-aware transcode          (fixes Skyworth stuttering)
3.  M6    Tags + Favorites + Filters      (foundation; blocks 5 others)
4.  M14   API keys                        (small; enables LLM-assisted M6)
5.  M9    Adult override                  (gates kid-side actions in M10-M12)
6.  M7    Watch menu                      (independent UX polish)
7.  M8    Browse UI + Library upgrades    (big lift; consumes M6 + M9)
8.  M10   Time limits                     (biggest behavioral change)
9.  M11   Body breaks                     (sits on M10 timer)
10. M12   Viewing controls                (independent of M10/M11)
11. M13   Time-based modes                (composes M6 + M10 + M12)
12. M15   Cable TV (channels)             (composes M6 + M8 + M10)
13. M16   External sources (research)     (research spike)
14. M17   Skip markers                    (placeholder; reach for when M5 UX settles)
```

## Why this order

### M-AT before M6

You're hitting stuttering on the Skyworth right now during M5
dogfooding. Every additional UX milestone we ship before M-AT
amplifies the pain (more time spent in the player = more stuttering).
M-AT is also small (4 issues) and has a clean, isolated scope.

### M6 before everything else (except M-AT)

M6 introduces tags, favorites, and per-profile tag filters - the
foundation for M8 (browse rows are tag-driven), M9 (override modal
edits tags + favorites), M13 (modes override tag filters), M15
(channels source from tags), and indirectly M14 (the LLM is going to
want to tag stuff). Five downstream milestones can't proceed without
it. Doing it first concentrates the schema work in one milestone
rather than spreading it across multiple.

### M14 before M9

M14 is tiny (3 issues, ~half a milestone of effort) and lets you
point an LLM at the admin REST API to help populate tags during M6.
Doing it right after M6 means the gap between "tags exist" and "tags
have useful content" is short. By the time M8 ships and surfaces tag
rows, the library is well-tagged.

### M9 before M10-M12

M9 defines the universal override gesture + PIN flow + override modal
shell. M10, M11, and M12 all hook actions into that modal (Grant
time, Skip body break, Set dim / red-shift / sleep timer). Doing M9
first means those later milestones land complete; doing them in any
other order means shipping placeholder buttons and circling back.

### M7 and M8 between M9 and M10

M7 is independent of M6/M9 and is a relatively quick UX polish; slot
it where it doesn't block anything. M8 is the biggest UX milestone -
do it after M9 so the override gesture works on browse tiles from day
one. Doing M8 before M10 means we can dogfood the new browse for a
while before piling time-limit machinery on top.

### M10 -> M11 -> M12

M10 is the biggest behavioral change in the kid app (whether the kid
can watch at all, not just what). M11 sits on M10's segment tracking
and timer infrastructure. M12 is independent of both but pairs well
with the override-modal work in M10/M11. Doing them in this order
keeps the override modal's "future hooks" placeholders short-lived.

### M13 last among behavioral milestones

M13 composes M6 (tag filters) + M10 (time limits) + M12 (viewing
controls). It can't ship until all three are stable. Doing it last
also means the "effective config" pattern it introduces is informed
by real M10+M12 friction.

### M15 after M13

M15 (channels) depends on M6 (sources from tags) and M8 (channel
tile is a new layout-row type) and M10 (auto-skip on locked items).
It doesn't depend on M13, but doing it after M13 keeps the
behavioral / synthesis milestones grouped together.

### M16 and M17 deferred

M16 (external sources research) is a time-boxed spike with no
production output; it can slot anywhere. Putting it near the end
means the research is informed by the rest of the system and we know
what we'd actually want from external sources.

M17 (skip markers) waits for M5 player UX to settle. Adding more
buttons to a transport that's still being iterated on is premature.

## Dependency graph

```
M5 ──┬──> M-AT ──> M6 ──┬──> M14
     │                  ├──> M9 ──┬──> M7
     │                  │         ├──> M8 ──┬──> M15
     │                  │         │         │
     │                  │         ├──> M10 ─┼──> M11
     │                  │         │         │
     │                  │         ├──> M12 ─┘
     │                  │         │
     │                  └─────────┴──> M13
     │
     └──> M17 (placeholder; needs M5 player UX stable)

M16 (research, no hard deps)
```

## Tracking

- **Status lives in GitHub, not here.** This doc is order + rationale
  only; it does not track what's done. For what's closed / in flight /
  next, query the milestones:
  `gh api repos/fisherevans/jellybean/milestones | jq '.[] | {title, state, open_issues, closed_issues}'`.
  Don't annotate this doc with "current" / "done" markers - they drift.
- Each issue body has a "Depends on" section listing prerequisite
  issues. Useful when picking up a single ticket.
- Caveat: code can run ahead of issue state. Backend + admin plumbing
  for a milestone often lands while its kid-side issues are still open,
  so confirm a feature's real state against the code, not just the
  issue flags.
- GitHub Projects boards aren't worth setting up for this size of
  work - a list works fine.

## When to deviate

- If M-AT turns out to be tractable in under a day, push through to
  M6 the same week.
- If M9's override flow surfaces real PIN-management UX issues, pause
  and address them before M10/M11/M12 build on top.
- If the M-AT research reveals that PlaybackInfo isn't actually the
  bottleneck (e.g. it's a Jellyfin transcoder cap), reconsider scope
  before continuing.
- If real kid-use during M5/M6 reveals patterns that would have
  changed M8's design, pause and revise M8's milestone description
  before starting it.

## Roadmap meta

- Update this doc only when the ordering or dependencies change - not
  when a milestone merely opens or closes (that's GitHub's job).
- New milestones get appended in the dependency graph + sequence.
- Don't renumber existing milestones - the labels are stable
  references in commit messages, PR titles, and history.
