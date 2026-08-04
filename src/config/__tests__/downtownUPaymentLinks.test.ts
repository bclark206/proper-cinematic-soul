import { describe, expect, it } from "vitest";
import { getDowntownUPaymentLinks } from "../downtownUPaymentLinks";

const configuredLinks = {
  VITE_DOWNTOWN_U_FLEX_5_URL: "https://square.link/u/flex5",
  VITE_DOWNTOWN_U_SCHOLAR_10_URL: "https://checkout.square.site/merchant/ML/scholar10",
  VITE_DOWNTOWN_U_RESIDENT_20_URL: "https://square.link/u/resident20",
  VITE_DOWNTOWN_U_SEMESTER_40_URL: "https://square.link/u/semester40",
};

describe("Downtown U reusable payment-link configuration", () => {
  it("returns a fixed URL for every plan only when the complete set is valid", () => {
    expect(getDowntownUPaymentLinks(configuredLinks)).toEqual(new Map([
      ["flex-5", "https://square.link/u/flex5"],
      ["scholar-10", "https://checkout.square.site/merchant/ML/scholar10"],
      ["resident-20", "https://square.link/u/resident20"],
      ["semester-40", "https://square.link/u/semester40"],
    ]));
  });

  it.each([
    "http://square.link/u/not-https",
    "https://square.link:443/u/explicit-default-port",
    " https://square.link/u/space-padded ",
    "https://square.link\\@evil.example/u/fake",
    "https://square.link.evil.example/u/fake",
    "https://evil.example/square.link/u/fake",
    "https://sub.square.link/u/fake",
    "https://square.link:8443/u/fake",
    "https://user:pass@square.link/u/fake",
    "https://square.link/",
    "not a URL",
  ])("fails closed for an unsafe payment URL: %s", (unsafeUrl) => {
    expect(getDowntownUPaymentLinks({ ...configuredLinks, VITE_DOWNTOWN_U_FLEX_5_URL: unsafeUrl })).toBeNull();
  });

  it.each([
    "https://square.link/u/flex%0A5",
    "https://square.link/u/flex%C2%85",
    "https://square.link/u/flex%E2%80%AE5",
    "https://square.link/u/flex%E2%80%8B5",
  ])("rejects percent-encoded control and formatting characters: %s", (unsafeUrl) => {
    expect(getDowntownUPaymentLinks({ ...configuredLinks, VITE_DOWNTOWN_U_FLEX_5_URL: unsafeUrl })).toBeNull();
  });

  it("rejects duplicate links so two displayed plans cannot charge through one checkout", () => {
    expect(getDowntownUPaymentLinks({
      ...configuredLinks,
      VITE_DOWNTOWN_U_SCHOLAR_10_URL: configuredLinks.VITE_DOWNTOWN_U_FLEX_5_URL,
    })).toBeNull();
  });

  it("fails closed when any one of the four reusable links is absent", () => {
    expect(getDowntownUPaymentLinks({ ...configuredLinks, VITE_DOWNTOWN_U_RESIDENT_20_URL: "" })).toBeNull();
  });

  it.each([
    ["C0", "\u0009"],
    ["DEL", "\u007f"],
    ["C1", "\u0085"],
    ["bidi override", "\u202e"],
    ["zero-width formatting", "\u200b"],
  ])("rejects %s characters instead of letting URL parsing normalize them", (_label, character) => {
    const unsafeUrl = `https://square.link/u/flex${character}5`;
    expect(getDowntownUPaymentLinks({ ...configuredLinks, VITE_DOWNTOWN_U_FLEX_5_URL: unsafeUrl })).toBeNull();
  });

  it.each(["constructor", "toString", "valueOf", "__proto__"])(
    "never resolves inherited key %s as a meal plan",
    (inheritedKey) => {
      const links = getDowntownUPaymentLinks(configuredLinks) as ReadonlyMap<string, string> | null;
      expect(links?.get(inheritedKey)).toBeUndefined();
    },
  );
});
