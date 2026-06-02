import { describe, expect, test } from "bun:test";
import { redact, redactValue } from "../src/redaction";

describe("redaction", () => {
  test("redacts likely secret assignments and bearer tokens", () => {
    const input = "api_key=abc123456789 password: hunter2 client_secret=\"supersecret\" Authorization: Bearer abcdefghijklmnop";

    expect(redact(input)).toBe(
      "api_key=[REDACTED] password: [REDACTED] client_secret=\"[REDACTED]\" Authorization: Bearer [REDACTED]",
    );
  });

  test("redacts nested values by sensitive key", () => {
    const value = redactValue({
      content: {
        body: "Use ghp_abcdefghijklmnopqrstuvwxyz123456",
      },
      accessToken: "lin_abcdefghijklmnopqrstuvwxyz123456",
    });

    expect(value).toEqual({
      content: {
        body: "Use [REDACTED]",
      },
      accessToken: "[REDACTED]",
    });
  });
});
