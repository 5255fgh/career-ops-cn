import {
  BridgeErrorResponseSchema,
  type BridgeErrorResponse,
} from "@career-ops-cn/shared";

export type BridgeErrorCode = BridgeErrorResponse["error"];

export interface BridgeFailure extends Error {
  code: BridgeErrorCode;
  publicMessage?: string;
  diagnosticId?: string;
}

interface BridgeFailureOptions extends ErrorOptions {
  publicMessage?: string;
  diagnosticId?: string;
}

export function bridgeFailure(
  code: BridgeErrorCode,
  message: string,
  options?: BridgeFailureOptions,
): BridgeFailure {
  return Object.assign(new Error(message, options), {
    code,
    ...(options?.publicMessage === undefined
      ? {}
      : { publicMessage: options.publicMessage }),
    ...(options?.diagnosticId === undefined
      ? {}
      : { diagnosticId: options.diagnosticId }),
  });
}

export function isBridgeFailure(error: unknown): error is BridgeFailure {
  return (
    error instanceof Error &&
    "code" in error &&
    BridgeErrorResponseSchema.safeParse({ error: error.code }).success
  );
}
