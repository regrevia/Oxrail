# Changelog

All notable project changes are documented here. The normative specification history remains in `spec/OXRAIL_SPEC.md`.

## [Unreleased]

- Real-host compatibility and benchmark evidence remain in progress.

## [0.1.0-alpha.2] - 2026-09-06

- Added a macOS-only, fixture-only private-input trial: a native secure field accepts only `oxrail_test_…` values, stores them as device-only Keychain items behind opaque references, clears an exactly matching system pasteboard value, proves local retrieval without exposing the value, and supports explicit revocation. It performs no network request and leaves Credential protection `INACTIVE`.

## [0.1.0-alpha.1] - 2026-09-05

- Published the current `dev` foundations as an immutable macOS trial build; the public adapter remains passive-only and all unproven Safety, Handoff, and Credential capabilities remain explicitly `INACTIVE`.
- Added a narrowly scoped fixture-local gate cleanup that may reopen only a ledger proven never to have caused presenter, Keychain, pasteboard, consumer, or secret effects; it holds the global mutex and gate lock, retires only durable completions, waits for real Post events, rejects generation ABA, writes an exact tombstone, and read-only reconciles errors. It never authorizes Agent resume, remains `INACTIVE`, and does not replace authenticated Host/enclave cleanup or G15 for products.
- Added an atomic final fixture-gate commit that validates the bounded Host-suspension receipt, then holds the global credential mutex, matching Handoff task lock, and gate file lock across the exact final snapshot and `PREPARING` to `ACTIVE` ledger write; cleanup/ABA, deadline, clock, and dead-lock cases fail closed, while the result remains explicitly non-authorizing and inactive. Product wiring stays forbidden until authenticated Host/enclave cleanup and G15 exist.
- Added one locked coordinator entry that atomically mints the current Handoff-bound fixture ticket and commits the global credential gate from `OPEN` to `PREPARING`; calls admitted first remain pending until their real Post, later Pre calls block, and all results remain non-authorizing and `INACTIVE`.
- Added a bounded, one-shot fixture Host-suspension observer that sandwiches a lock-free serialized-wire callback between two exact global-credential-then-Handoff-task snapshots, with receiver deadline, rollback, and raw-control-alias checks; external cleanup-to-open invalidates the final snapshot, so the fixture explicitly does not claim continuous exclusion. It remains `UNVERIFIED / INACTIVE` and cannot activate the gate, present UI, or touch a credential.
- Added a non-product macOS presentation checkpoint shared with Core through one golden v2 ticket: it strictly validates the embedded registry, full ticket digest and lease timing, emits only an opaque prompt-context hash, and remains explicitly `NOT_AUTHORIZED / UNVERIFIED / NOT_PRESENTED / INACTIVE` with no presenter, secret or Keychain path.
- Restricted credential ticket minting to the locked Handoff coordinator: caller-owned inputs are snapshotted, strict current ACTIVE state/barrier and Host checks require a physically empty active journal, and only a v2 opaque anchor is emitted; naked leases and v1 tickets fail closed, raw browser-control identity is omitted, and locally substituted valid binding hashes remain explicitly untrusted until a prompt-time authenticated Host recheck exists.
- Added a non-product macOS credential-enclave boundary that builds one fixed, never-presented `NSSecureTextField` surface from the embedded registry and exercises only an internal secret sink; production has no prompt launcher or credential writer and remains explicitly `INACTIVE`.
- Wired the fixture-only credential fence through every Hook-visible Pre/Post tool event before profile or payload classification, using a dedicated opt-in state root and one mutex shared with gate transitions; only real Post events settle tracked calls, while INACTIVE bootstrap leaves the fence unarmed and lock-held OPEN journal faults preserve Native execution with explicit `BYPASSED/INACTIVE` without weakening mutex failures.
- Added the single-attempt locked Handoff completion consume/CAS: it revalidates the active barrier, bounded journal, global exclusive-tab lease, suspended Agent lanes, fresh same-tab receipt, monotonic deadlines, and atomically commits only a digest marker with Human-owned `HANDOFF_VERIFYING`; a bounded process-local attempt ledger prevents fixture retries, while runtime remains non-authorizing until real Host transport and challenge-ledger evidence exist.
- Added a runtime-only non-secret Handoff verification sample and pure completion-candidate gate based on authenticated active probes, receiver monotonic time, continuous origin-only coverage, and a required later locked Core recheck; it cannot verify, resume, or release the user lease.
- Split minimal Agent-facing Handoff input/result from strict runtime-only Host request, completion, and result contracts; only the exactly equivalent tool-input JSON Schema is published, all validation is non-authorizing, and Handoff remains inactive.
- Added a process-local, fixture-only macOS opaque credential-reference lifecycle with Security.framework randomness and exact scope, TTL, generation, registry-hash, revocation, and one-shot replay checks; the public observation never returns the reference and remains inactive.
- Added a build-fixed, read-only macOS credential-registry validator for one exact API-key fixture template/HTTPS consumer; it only reports non-authorizing structure evidence and always leaves Credential activation inactive.
- Added a manual, permission-minimal macOS Chrome MV3 probe for the controlled loopback fixture; it tests same-tab move/focus/restore primitives only and always reports Host fence unavailable and Handoff inactive.
- Added a read-only macOS Security.framework launcher/helper identity verifier foundation with fixed non-authorizing output, exact Team/signing-ID/CDHash/designated-requirement checks, and thin Mach-O enforcement; release pins remain deliberately unconfigured, so production reports `INACTIVE` and no Credential path is activated.
- Tightened fixture-only Handoff receipt admission so Host Profile and complete same-tab scope bindings, strict hash forms, and receipt/lease timing must all match before a user lease can activate; no production Host verifier is connected yet.
- Upgraded HostProfile to v5 with exact lowercase 20-byte Security.framework CDHash fields for one architecture-specific launcher/helper artifact, distinct from 64-hex SHA-256 evidence and trust-root digests; Credential activation remains hard-rejected without the native verifier.
- Bound persisted action signatures to a purpose-separated local HMAC key generation with safe legacy-state migration.
- Added a monotonic Handoff admission gate, exact v2 tool-call reconciliation, serialized activation/cancel publication, and ownership-aware timeout recovery; activation requires a fresh Host-minted same-tab/native-action-fence receipt.
- Split durable tool-call replay history from a streaming, bounded active Handoff index, with crash intents, lock-serialized Post/state cleanup, and safe `UNKNOWN` degradation for dirty, legacy, corrupt, excessive-debris, or over-ceiling indexes.
- Bound credential provisioning to one allowlisted ID, the active real-tab Handoff scope, a fixed registry, a non-authorizing fixture ticket, and a fixed secret-free public result.
- Added an explicit, input-free macOS Keychain synthetic round-trip probe with fixed secret-free output and cleanup on every post-locator path; it remains fixture-only and cannot activate Credential protection.
- Added a durable, fail-closed credential execution gate ledger with monotonic prepare/active/cleanup transitions, distinct cleanup evidence, bounded private state, conservative crash recovery, and exact replay detection; it remains fixture-only and is not authorization or attestation.
- Added a fixture-only global Credential Tool Fence primitive with locally keyed call identities, a serialized 256-marker active ceiling across legacy and current schemas, exact gate snapshot checks, durable Post cleanup, and bounded quiescence reporting; this local primitive alone cannot satisfy G15.

## [0.1.0-alpha.0] - 2026-09-04

- Added the GitHub marketplace plugin, Oxrail Skill, and Codex lifecycle hooks.
- Added side-effect-free setup verification with `INSTALLED`, `CONFIGURED`, and `VERIFIED` states.
- Added passive first-browser-call verification and fail-open `BYPASSED` behavior.
- Added exact host-inventory bootstrap and short-lived, hash/profile/session-bound Hook observations.
- Required host UI review/trust for hooks; hook hash changes return to host reauthorization.
- Added explicit `INACTIVE` reporting for unavailable Safety/Handoff capabilities.
- Kept the alpha runtime hard-limited to passive `ADVISORY_ONLY` verification until a real enforcement adapter is accepted.
- Added the native-interaction fixture, evidence tooling, and v0.1 release gate.
- Added an immutable alpha plugin ref and a Luna-first 4-task/8-arm Pilot with deterministic reset and evidence receipts.
