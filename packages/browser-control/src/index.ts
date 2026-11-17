/* Public surface of the opt-in Browser Control package.
 *
 * Hosts and tests import from here; nothing in here is loaded by the native
 * route unless a host explicitly configured this MCP server.
 */

export * from "./types.js";
export * from "./read.js";
export * from "./route.js";
export * from "./chrome.js";
export * from "./cdp.js";
export * from "./tools.js";
export * from "./mcp.js";
