import type { Server } from "node:http";

export const FIXTURE_INITIAL_POSTCONDITIONS: Readonly<
  Record<string, string | number | boolean>
>;
export function createResetReceipt(
  input: { run_id: string; arm_id: string; task_id: string; seed: string },
  options?: { fixturePath?: string; origin?: string },
): Promise<{
  schema_version: 1;
  receipt_id: string;
  run_id: string;
  arm_id: string;
  task_id: string;
  seed: string;
  fixture_sha256: string;
  initial_state_hash: string;
  initial_state: Record<string, string | number | boolean>;
  reset_url: string;
}>;
export function createFixtureServer(options?: {
  fixturePath?: string;
  origin?: string;
}): Server;
