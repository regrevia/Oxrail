import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await rm("lab/dist", { recursive: true, force: true });
await rm("release", { recursive: true, force: true });
await rm("coverage", { recursive: true, force: true });
await rm("playwright-report", { recursive: true, force: true });
await rm("test-results", { recursive: true, force: true });
