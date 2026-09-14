# Oxrail Lab Codex Hook probe

Internal, opt-in `WP-LAB-004` probe. Install and trust this plugin only for a
controlled run. It records bounded Hook metadata to `~/.oxrail-lab` and emits no
policy decision or model context. Disable or remove it when monitoring is off.

This probe does not prove Chrome coverage by being installed. A real, visible
`@Chrome` action and its controlled postcondition are required. Without an exact
host inventory, any observed tool name remains unclassified and the result is
not accepted as supported.
