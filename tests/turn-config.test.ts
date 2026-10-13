import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

function reservationFits(config: string): boolean {
  const value = (name: string) => {
    const matches = [...config.matchAll(new RegExp(`^${name}=(\\d+)$`, "gm"))];
    if (matches.length !== 1) throw new Error(`Expected one explicit ${name}`);
    const number = Number(matches[0][1]);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Invalid ${name}`);
    return number;
  };
  return value("max-bps") * value("total-quota") <= value("bps-capacity");
}

describe("bounded coturn bandwidth reservation", () => {
  const template = readFileSync(new URL("../deploy/coturn/turnserver.conf.example", import.meta.url), "utf8");
  const fixture = (maxBps: number, totalQuota: number, capacity: number) => template
    .replace("REPLACE_MAX_BPS", String(maxBps))
    .replace("REPLACE_TOTAL_QUOTA", String(totalQuota))
    .replace("REPLACE_BPS_CAPACITY", String(capacity));

  test("template requires deployment-specific quotas and ports", () => {
    expect(template).toContain("user-quota=REPLACE_USER_QUOTA");
    expect(template).toContain("min-port=REPLACE_MIN_RELAY_PORT");
    expect(template).toContain("max-port=REPLACE_MAX_RELAY_PORT");
    expect(template).toContain("bps-capacity=REPLACE_BPS_CAPACITY");
  });
  test("synthetic allocations fit a synthetic aggregate budget", () => {
    expect(reservationFits(fixture(5, 3, 16))).toBe(true);
    expect(reservationFits(fixture(6, 3, 16))).toBe(false);
  });
  test("does not silently accept unlimited or duplicate budget values", () => {
    expect(() => reservationFits(fixture(5, 3, 0))).toThrow();
    expect(() => reservationFits(`${fixture(5, 3, 16)}\nmax-bps=5\n`)).toThrow();
  });
});
