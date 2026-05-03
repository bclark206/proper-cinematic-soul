import { describe, it, expect } from "vitest";
import { generatePickupTimes, getStoreStatus } from "../storeHours";

describe("storeHours scheduling", () => {
  it("allows scheduling for today's opening time before the restaurant opens", () => {
    const beforeOpen = new Date("2026-05-04T13:00:00-04:00"); // Monday 1 PM ET

    const times = generatePickupTimes(beforeOpen);

    expect(times.length).toBeGreaterThan(0);
    expect(times[0].label).toBe("Today 3:00 PM");
    expect(times[0].value).toBe("2026-05-04T19:00:00.000Z");
    expect(times.every((time) => time.value !== "asap")).toBe(true);
  });

  it("rolls scheduled orders to the next open day after closing", () => {
    const afterClose = new Date("2026-05-04T23:30:00-04:00"); // Monday 11:30 PM ET

    const times = generatePickupTimes(afterClose);

    expect(times.length).toBeGreaterThan(0);
    expect(times[0].label).toBe("Tomorrow 3:00 PM");
    expect(times[0].value).toBe("2026-05-05T19:00:00.000Z");
  });

  it("marks the store closed before opening but still reports today's hours", () => {
    const beforeOpen = new Date("2026-05-04T13:00:00-04:00");

    const status = getStoreStatus(beforeOpen);

    expect(status.isOpen).toBe(false);
    expect(status.hours).toBe("3:00 PM – 11:00 PM");
    expect(status.nextOrderingLabel).toBe("Today 3:00 PM");
  });
});
