# Compatibility

Compatibility is a tuple, not a product-wide boolean:

```text
surface + host build + Computer Use plugin version + browser path + tool route + Hook definition hash
```

| Surface                  | Browser path                    | Public contract                                                    | Evidence required                                              | Default before evidence       |
| ------------------------ | ------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- | ----------------------------- |
| Codex CLI                | Chrome extension / Computer Use | Plugins and Codex hooks are documented                             | Exact real route, matcher, granularity, Pre/Post coverage, NIF | `ADVISORY_ONLY` or `BYPASSED` |
| Codex in ChatGPT desktop | Chrome extension / Computer Use | Plugin surface and Codex hooks are documented separately           | Same tuple must be probed on this surface                      | `ADVISORY_ONLY` or `BYPASSED` |
| ChatGPT Work / Web       | Any                             | Plugin/Skill availability does not establish Codex lifecycle hooks | Independent host adapter and HostRealityBench                  | No Hook enforcement claim     |
| Codex IDE extension      | Any                             | Current plugin docs say plugins are unavailable                    | Not applicable for v0.1                                        | Unsupported install surface   |

Run setup verification after install and after any host, Computer Use plugin, browser path, or Hook hash change. A stale/untrusted profile disables Oxrail claims, not native Computer Use:

```text
Oxrail optimization unavailable / BYPASSED
Safety protection: INACTIVE
Handoff protection: INACTIVE
```

No real-host profile is promoted by documentation alone. Version-bound reports belong under this directory once their sanitized evidence manifests pass the specification gates.
