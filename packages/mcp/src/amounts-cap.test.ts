import { describe, it, expect } from "vitest";
import { capDecimal10, decimal10 } from "./amounts.js";

/** A decimal string with at most 10 places, in atomic units (1e-10). */
const units = (s: string): bigint => {
  const [int, frac = ""] = s.split(".");
  return BigInt(int!) * 10n ** 10n + BigInt(frac.padEnd(10, "0"));
};

/** floor(x * 1e10), exactly, for a double x >= 0: the double is m * 2^e. */
const exactUnitsFloor = (x: number): bigint => {
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, x);
  const bits = v.getBigUint64(0);
  const expBits = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & ((1n << 52n) - 1n);
  const m = expBits === 0 ? frac : frac | (1n << 52n);
  const e = (expBits === 0 ? 1 : expBits) - 1075;
  const n = m * 10n ** 10n;
  return e >= 0 ? n << BigInt(e) : n >> BigInt(-e);
};

describe("capDecimal10: a cap as the signer reads it", () => {
  it("keeps a decimal cap exact where decimal10 loses an atomic unit", () => {
    expect(decimal10(0.57)).toBe("0.5699999999"); // the bug: a merchant charging 0.57 is refused
    expect(capDecimal10(0.57)).toBe("0.57");
    expect(capDecimal10(0.41)).toBe("0.41");
    expect(capDecimal10(1.13)).toBe("1.13");
  });

  it("every two-decimal cap from 0.01 to 10.00 reads back exactly", () => {
    const wrong: string[] = [];
    for (let i = 1; i <= 1000; i++) {
      const t = (i / 100).toFixed(2);
      const want = t.replace(/0+$/, "").replace(/\.$/, "");
      if (capDecimal10(Number(t)) !== want) wrong.push(t);
    }
    expect(wrong).toEqual([]);
  });

  it("what is left of a two-decimal day after two-decimal spending reads back exactly", () => {
    expect(5 - 4.99).toBe(0.009999999999999787); // a few ulps of 5, far more than of 0.01
    expect(capDecimal10(5 - 4.99, 5)).toBe("0.01");
    const wrong: string[] = [];
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 16807) % 2147483647;
      return Math.floor((seed / 2147483647) * n);
    };
    for (let k = 0; k < 5000; k++) {
      const capCents = 1 + rnd(100_000); // 0.01 .. 1000.00
      const spentCents = rnd(capCents);
      const day = capCents / 100;
      const left = day - spentCents / 100;
      const want = ((capCents - spentCents) / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
      if (capDecimal10(left, day) !== want) wrong.push(`${day} - ${spentCents / 100}`);
    }
    expect(wrong).toEqual([]);
  });

  it("drops a real part of an atomic unit instead of rounding up past the cap", () => {
    expect(capDecimal10(0.12345678905)).toBe("0.123456789");
    expect(capDecimal10(1.00000000009)).toBe("1");
    expect(capDecimal10(0.99999999999)).toBe("0.9999999999");
    expect(capDecimal10(0.00000000004)).toBe("0");
    expect(capDecimal10(0)).toBe("0");
  });

  it("never exceeds a cap by 1 atomic unit, and above it only by float error", () => {
    let seed = 42;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let k = 0; k < 20000; k++) {
      const x = rnd() * 10 ** Math.floor(rnd() * 6 - 1);
      const s = capDecimal10(x);
      expect(units(s) <= exactUnitsFloor(x) + 1n, `${x} -> ${s}`).toBe(true);
      expect(Number(s) - x <= x * Number.EPSILON * 66, `${x} -> ${s}`).toBe(true);
      // Computed from a larger number (what is left of a day): its float error.
      const from = x * (1 + rnd() * 1000);
      const t = capDecimal10(x, from);
      expect(units(t) <= exactUnitsFloor(x) + 1n, `${x} of ${from} -> ${t}`).toBe(true);
      expect(Number(t) - x <= from * Number.EPSILON * 66, `${x} of ${from} -> ${t}`).toBe(true);
    }
  });
});
