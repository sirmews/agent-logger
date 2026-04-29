import { describe, expect, test } from "bun:test";
import {
  createRedactionState,
  getBuiltinRedactionPatterns,
  getExtraRedactionPatterns,
  parseExtraRedactionPatterns,
  redactPayloadForExport,
} from "../src/index";

describe("custom redaction patterns", () => {
  test("adds valid custom regex patterns", () => {
    const patterns = getExtraRedactionPatterns("TOKEN-[A-Z]{3};abc-\\w+");
    expect(patterns).toHaveLength(2);
    expect(patterns[0].regex.source).toBe("TOKEN-[A-Z]{3}");
    expect(patterns[1].regex.source).toBe("abc-\\w+");
  });

  test("ignores invalid custom regex patterns", () => {
    const patterns = getExtraRedactionPatterns("[unclosed");
    expect(patterns).toHaveLength(0);
  });

  test("reports invalid custom regex patterns in parser result", () => {
    const parsed = parseExtraRedactionPatterns("[unclosed;valid-\\w+");
    expect(parsed.patterns).toHaveLength(1);
    expect(parsed.invalidPatterns).toHaveLength(1);
    expect(parsed.invalidPatterns[0]).toBe("[unclosed");
  });

  test("redacts deterministic tokens with custom and builtin patterns", () => {
    const patterns = [
      ...getBuiltinRedactionPatterns(),
      ...getExtraRedactionPatterns("SECRET-[A-Z]{3}"),
    ];
    const input = {
      text:
        "sk-aaaaaaaaaaaaaaaaaaaaaa and Bearer tokenX and SECRET-ABC appear. SECRET-ABC repeats.",
      nested: { again: "SECRET-ABC" },
    };

    const out = redactPayloadForExport(
      input,
      createRedactionState(),
      patterns,
    ) as typeof input;

    expect(out.text).not.toContain("sk-aaaaaaaaaaaaaaaaaaaaaa");
    expect(out.text).not.toContain("Bearer tokenX");
    expect(out.text).toContain("<<REDACTED_OPENAI_KEY_001>>");
    expect(out.text).toContain("<<REDACTED_BEARER_001>>");
    expect(out.text).toContain("<<REDACTED_CUSTOM_001>>");
    expect(out.nested.again).toBe("<<REDACTED_CUSTOM_001>>");
  });

  test("returns unmodified payload when no patterns are supplied", () => {
    const input = { text: "sk-aaaaaaaaaaaaaaaaaaaaaa" };
    const out = redactPayloadForExport(input, createRedactionState(), []);
    expect(out).toEqual(input);
  });
});
