// SNP v1 — códigos de error y cierre (runtime-agnóstico).

export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "READ_ONLY",
  "DOCUMENT_NOT_FOUND",
  "MESSAGE_TOO_LARGE",
  "RATE_LIMITED",
  "INVALID_UPDATE",
  "UNKNOWN_MESSAGE",
  "PROTOCOL_VERSION_UNSUPPORTED",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const CLOSE_CODES = {
  PROTOCOL_VIOLATION: 4400,
  SESSION_INVALID: 4401,
  ACCESS_REVOKED: 4403,
  HEARTBEAT_TIMEOUT: 4408,
  MESSAGE_TOO_LARGE: 4413,
  RATE_LIMITED: 4429,
} as const;

export type CloseCodeName = keyof typeof CLOSE_CODES;
