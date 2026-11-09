/** Amount formatting shared by the tools' text. */

/** A CC amount as a plain decimal string with at most 10 places (the ledger's
 *  precision), rounded DOWN so a ceiling never grows by rounding. */
export const decimal10 = (cc: number): string => {
  const s = (Math.floor(cc * 1e10) / 1e10).toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return s === "" ? "0" : s;
};

/** A fixed-scale decimal string without its trailing zeros: "0.2500000000" →
 *  "0.25", "1.0000000000" → "1". */
export const trimDecimal = (s: string): string =>
  s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;

/**
 * A cap as a decimal string with at most 10 places, for the signer. decimal10
 * floors `x * 1e10`, and that product misses a decimal cap by float error
 * (0.57 * 1e10 = 5699999999.999999), so 0.57 became "0.5699999999" and a
 * merchant charging exactly 0.57 was refused. Here the nearest atomic unit is
 * taken when it lies above `x * 1e10` by no more than float error; anything
 * more is a real part of an atomic unit, which a cap drops. `from` is the
 * largest number `x` was computed from (the daily cap, for what is left of a
 * day): the error of `5 - 4.99` is a few ulps of 5, not of 0.01.
 */
export const capDecimal10 = (x: number, from = x): string => {
  if (!(x > 0)) return "0";
  const scaled = x * 1e10;
  const near = Math.round(scaled);
  const floatError = Math.max(x, from) * 1e10 * Number.EPSILON * 64;
  const units = near - scaled <= floatError ? near : Math.floor(scaled);
  const digits = BigInt(units).toString().padStart(11, "0");
  return trimDecimal(`${digits.slice(0, -10)}.${digits.slice(-10)}`);
};
