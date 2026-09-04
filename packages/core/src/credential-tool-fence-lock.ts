import { transitionBrowserTaskStateWithRetry } from "./store.js";

export const CREDENTIAL_TOOL_FENCE_SCOPE = {
  sessionId: "__oxrail_internal_credential_tool_fence_global_v1__",
  taskId: "__oxrail_internal_credential_tool_fence_global_v1__",
} as const;

export const withCredentialToolFenceLock = async <Result>(
  root: string,
  operation: () => Promise<Result>,
): Promise<Result> =>
  transitionBrowserTaskStateWithRetry(
    root,
    CREDENTIAL_TOOL_FENCE_SCOPE,
    async (state) => {
      if (state) throw new Error("reserved credential fence scope is occupied");
      return { value: await operation() };
    },
  );
