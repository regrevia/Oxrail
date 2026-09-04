export function fingerprint(value: unknown): string;
export function pairedSchedule(
  testIds: readonly string[],
  seed: string,
): Array<{
  testId: string;
  rank: string;
  variants: Array<"baseline" | "oxrail">;
}>;
export function assertPairedInitialState(
  baseline: unknown,
  oxrail: unknown,
): string;
