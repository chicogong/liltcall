import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { en, resolveLocale, translate, zhCN } from "../apps/web/src/i18n";

describe("English and Simplified Chinese copy", () => {
  it("has matching keys and template variables", () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(zhCN[key].match(/\{[a-zA-Z]+\}/g) ?? []).toEqual(en[key].match(/\{[a-zA-Z]+\}/g) ?? []);
      expect(zhCN[key].trim()).not.toBe("");
    }
  });

  it("prefers a saved choice over browser language and detects Chinese variants", () => {
    expect(resolveLocale(null, "zh-TW")).toBe("zh-CN");
    expect(resolveLocale(null, "en-US")).toBe("en");
    expect(resolveLocale("en", "zh-CN")).toBe("en");
    expect(resolveLocale("zh-CN", "en-US")).toBe("zh-CN");
  });

  it("localizes parameterized labels without changing room identifiers", () => {
    expect(translate("zh-CN", "roomName", { id: "ABCD1234" })).toBe("房间 ABCD1234");
    expect(translate("en", "firstRtp", { seconds: "0.2" })).toBe("first RTP 0.2s");
  });

  it("has translations for every static text and accessible label in the page", () => {
    const html = readFileSync(new URL("../apps/web/index.html", import.meta.url), "utf8");
    const keys = [...html.matchAll(/data-i18n(?:-aria-label)?="([a-zA-Z]+)"/g)].map((match) => match[1]);
    expect(keys.length).toBeGreaterThan(30);
    for (const key of keys) expect(en).toHaveProperty(key);
  });
});
