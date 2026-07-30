import { describe, expect, it } from "vitest";
import { generatePickupTimes, getStoreStatus } from "../storeHours";

describe("storeHours scheduling", () => {
  it("marks Monday closed before 5 PM and offers the opening pickup slot", () => {
    const beforeOpen = new Date("2026-05-04T13:00:00-04:00"); // Monday 1 PM ET

    const status = getStoreStatus(beforeOpen);
    const times = generatePickupTimes(beforeOpen);

    expect(status).toMatchObject({
      isOpen: false,
      hours: "5:00 PM – 12:00 AM",
      nextOrderingLabel: "Today 5:00 PM",
    });
    expect(times[0]).toEqual({
      label: "Today 5:00 PM",
      value: "2026-05-04T21:00:00.000Z",
    });
    expect(times.every((time) => time.value !== "asap")).toBe(true);
  });

  it("keeps Monday open late and offers pickup slots through 11:45 PM", () => {
    const lateEvening = new Date("2026-05-04T22:30:00-04:00"); // Monday 10:30 PM ET

    const status = getStoreStatus(lateEvening);
    const times = generatePickupTimes(lateEvening);

    expect(status.isOpen).toBe(true);
    expect(status.hours).toBe("5:00 PM – 12:00 AM");
    expect(times.slice(0, 4).map((time) => time.label)).toEqual([
      "Today 11:00 PM",
      "Today 11:15 PM",
      "Today 11:30 PM",
      "Today 11:45 PM",
    ]);
    expect(times[4].label).toBe("Tomorrow 5:00 PM");
  });

  it.each([
    ["Friday", "2026-05-08T13:00:00-04:00", "12:00 PM – 12:00 AM"],
    ["Saturday", "2026-05-09T13:00:00-04:00", "12:00 PM – 12:00 AM"],
    ["Sunday", "2026-05-10T13:00:00-04:00", "11:00 AM – 11:00 PM"],
  ])("reports the correct %s hours", (_day, timestamp, hours) => {
    expect(getStoreStatus(new Date(timestamp))).toMatchObject({ isOpen: true, hours });
  });

  it.each([
    ["Friday", "2026-05-08T10:00:00-04:00", "Today 12:00 PM", "2026-05-08T16:00:00.000Z"],
    ["Saturday", "2026-05-09T10:00:00-04:00", "Today 12:00 PM", "2026-05-09T16:00:00.000Z"],
    ["Sunday", "2026-05-10T10:00:00-04:00", "Today 11:00 AM", "2026-05-10T15:00:00.000Z"],
  ])("starts %s pickup slots at opening", (_day, timestamp, label, value) => {
    expect(generatePickupTimes(new Date(timestamp))[0]).toEqual({ label, value });
  });
});
