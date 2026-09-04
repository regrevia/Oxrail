# Oxrail principles

These invariants mirror `SEC-45` of the authoritative specification. If wording differs, `spec/OXRAIL_SPEC.md` wins.

1. **Native first (`INV-NATIVE-001`).** Reuse a suitable host-native structured tool or Computer Use path.
2. **Native write authority (`INV-WRITE-001`).** Native Computer Use owns page writes, mouse, keyboard, scroll, drag, and focus during normal operation.
3. **Native Interaction Fidelity (`INV-NIF-001`).** Preserve virtual pointer, input, viewport, and frame/screenshot feedback semantics.
4. **Ordinary pass-through (`INV-PASS-001`).** Pass ordinary non-risk actions through unchanged.
5. **No low-level rewrite (`INV-MUT-001`).** Do not change coordinates, paths, deltas, keys, click count, hover, or focus by default.
6. **Observe less, safely (`INV-OBS-001`).** Never remove control-critical metadata to make an observation smaller.
7. **Deterministic before reasoning (`INV-DET-001`).** Prefer a verifiable recovery step over more unconstrained reasoning.
8. **No blind retries (`INV-RETRY-001`).** Bound no-progress attempts without false-blocking normal primitives.
9. **Human boundary is a feature (`INV-HUMAN-001`).** Hand the real browser to the user when human action is required.
10. **Exclusive ownership (`INV-LEASE-001`).** Native and Human do not own browser input simultaneously; Oxrail never owns the pointer.
11. **Secrets stay in the real browser (`INV-SECRET-001`).** Secrets do not enter chat, Oxrail forms, traces, or caches.
12. **Fresh resume (`INV-RESUME-001`).** Invalidate old coordinates, references, and actions after Handoff.
13. **No interfering overlay (`INV-UI-001`).** Do not affect hit testing, layout, focus, or scrolling during normal operation.
14. **Fail honestly (`INV-HONEST-001`).** Unsupported host capabilities degrade visibly; evidence from one surface does not transfer to another.
15. **Evidence over marketing (`INV-EVID-001`).** Performance, safety, compatibility, and fidelity claims require reproducible evidence.
16. **Thin adapters (`INV-THIN-001`).** Keep host-specific behavior out of the policy core.
17. **Every version closes a loop (`INV-VERSION-001`).** No tests, evidence, and release gate means no completed version.
18. **One living spec (`INV-SINGLE-001`).** The canonical specification and work-package ledger live in one file.

Installation adds four operational corollaries: never bypass host Hook trust; never create a real Browser action as an installation test; fail open to native Computer Use when Oxrail is unavailable; and label inactive Safety/Handoff protection explicitly.
