// The code app's codes (F40, src/totp.ts) against RFC 6238's own test values.

import { describe, expect, test } from "bun:test";
import { base32, codeAt, fromBase32, matchStep } from "../src/totp";

const RFC = Buffer.from("12345678901234567890"); // RFC 6238 appendix B, SHA-1

describe("two-step codes (F40)", () => {
  test("RFC 6238's SHA-1 values", () => {
    for (const [t, want] of [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]] as const)
      expect(codeAt(RFC, Math.floor(t / 30), 8)).toBe(want);
    expect(codeAt(RFC, 1)).toBe("287082"); // six digits, as code apps show
  });
  test("a code matches its step and one either side, nothing further", () => {
    const now = 1_700_000_000_000, s = Math.floor(now / 30_000);
    expect(matchStep(RFC, codeAt(RFC, s), now)).toBe(s);
    expect(matchStep(RFC, codeAt(RFC, s - 1), now)).toBe(s - 1);
    expect(matchStep(RFC, codeAt(RFC, s + 1), now)).toBe(s + 1);
    expect(matchStep(RFC, codeAt(RFC, s - 2), now)).toBeNull();
    expect(matchStep(RFC, `${codeAt(RFC, s).slice(0, 3)} ${codeAt(RFC, s).slice(3)}`, now)).toBe(s); // a space typed in the middle
    expect(matchStep(RFC, "12345", now)).toBeNull();
  });
  test("base32 both ways, as code apps read it", () => {
    expect(base32(RFC)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(fromBase32("gezd gnbv gy3t qojq gezd gnbv gy3t qojq").equals(RFC)).toBe(true);
  });
});
