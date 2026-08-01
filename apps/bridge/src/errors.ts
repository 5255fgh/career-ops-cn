import {
  BridgeErrorResponseSchema,
  type BridgeErrorResponse,
} from "@career-ops-cn/shared";

export type BridgeErrorCode = BridgeErrorResponse["error"];

export interface BridgeFailure extends Error {
  code: BridgeErrorCode;
}

export function bridgeFailure(
  code: BridgeErrorCode,
  message: string,
  options?: ErrorOptions,
): BridgeFailure {
  return Object.assign(new Error(message, options), { code });
}

export function isBridgeFailure(error: unknown): error is BridgeFailure {
  return (
    error instanceof Error &&
    "code" in error &&
    BridgeErrorResponseSchema.safeParse({ error: error.code }).success
  );
}
