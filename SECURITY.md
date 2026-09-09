# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for `regrevia/Oxrail` when available. Do not open a public issue containing credentials, tokens, private page content, exploit details, or secret-bearing traces.

Include the affected Oxrail version/commit, host surface and build, browser path, reproduction steps using synthetic data, and the observed impact. Remove secrets before attaching logs.

## v0.1 security boundary

Oxrail is experimental. Installation does not make Safety or Secure Handoff active.

- Native Computer Use remains responsible for browser execution.
- The host's sandbox, approvals, Hook trust, and browser controls remain authoritative.
- Oxrail hooks run only after the user reviews and trusts their current definition through the host UI.
- If an Oxrail hook is unavailable or fails, Native Computer Use continues and Oxrail reports `BYPASSED`; Safety/Handoff report `INACTIVE`.
- A Skill, installed plugin, `CONFIGURED` status, or passive first-call marker is not an end-to-end secret guarantee.

Do not use a real credential, OTP, payment, production account, or private page as a test fixture. Security/Handoff claims require the evidence and gates defined in `spec/OXRAIL_SPEC.md`.

Supported versions will be listed in `docs/status/` after release. Until then, reports against the current default branch are welcome.
