const REDACTED = "[REDACTED]";

const SECRET_ASSIGNMENT =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|private[_-]?key)\b(\s*[:=]\s*)(["']?)([^\s"',;]+)(["']?)/gi;
const JSON_SECRET =
  /("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|private[_-]?key)"\s*:\s*")([^"]+)(")/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g;
const KNOWN_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|lin_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;

export function redact(value: string): string {
  return value
    .replace(JSON_SECRET, `$1${REDACTED}$3`)
    .replace(SECRET_ASSIGNMENT, (_match, key: string, separator: string, openingQuote: string, _secret: string, closingQuote: string) => {
      return `${key}${separator}${openingQuote}${REDACTED}${closingQuote}`;
    })
    .replace(BEARER_TOKEN, `Bearer ${REDACTED}`)
    .replace(KNOWN_TOKEN, REDACTED)
    .replace(URL_CREDENTIALS, `$1${REDACTED}:${REDACTED}@`);
}

export function redactValue<T>(value: T): T {
  if (typeof value === "string") {
    return redact(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item)) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, shouldRedactKey(key) ? REDACTED : redactValue(entry)]),
  ) as T;
}

function shouldRedactKey(key: string): boolean {
  return /^(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|private[_-]?key)$/i.test(
    key,
  );
}
