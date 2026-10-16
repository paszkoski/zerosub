import { describe, expect, it } from "vitest";
import type { Usage } from "../shared/model";
import { SwitchGuard } from "./switch-guard";
import { mergeUsage, parseGoUsage, retryDelayMs, showLimit } from "./usage";

const reading = (patch: Partial<Usage> = {}): Usage => ({
  fetchedAt: "2026-09-23T08:00:00.000Z",
  windows: [
    { id: "five_hour", label: "5-hour", usedPercent: 92, resetsAt: "2026-09-23T08:10:00.000Z" },
    { id: "seven_day", label: "Weekly", usedPercent: 9, resetsAt: "2026-09-29T20:00:00.000Z" },
    { id: "weekly_fable", label: "Weekly · Fable", usedPercent: 0, resetsAt: "2026-09-29T20:00:00.000Z" },
  ],
  error: null,
  cached: false,
  resets: null,
  ...patch,
});

describe("showLimit", () => {
  it("fills the window that resets when the limit notice says", () => {
    const shown = showLimit(reading(), "2026-09-23T08:10:00.000Z");
    expect(shown.windows.map((window) => window.usedPercent)).toEqual([100, 9, 0]);
  });

  it("picks the fullest of windows resetting together", () => {
    const shown = showLimit(reading(), "2026-09-29T20:00:00.000Z");
    expect(shown.windows.map((window) => window.usedPercent)).toEqual([92, 100, 0]);
  });

  it("leaves the reading alone when no window matches or the time is unknown", () => {
    expect(showLimit(reading(), "2026-09-25T00:00:00.000Z")).toEqual(reading());
    expect(showLimit(reading(), null)).toEqual(reading());
  });
});

describe("mergeUsage", () => {
  it("keeps the last windows through a failed or rate-limited refresh", () => {
    const merged = mergeUsage(reading(), reading({ fetchedAt: "2026-09-23T08:05:00.000Z", windows: [], error: "offline" }));
    expect(merged.windows).toHaveLength(3);
    expect(merged.error).toBe("offline");
    expect(merged.fetchedAt).toBe("2026-09-23T08:00:00.000Z");
  });

  it("only lets the CLI's cached copy replace an older reading", () => {
    const older = reading({ fetchedAt: "2026-09-23T07:00:00.000Z", cached: true });
    expect(mergeUsage(reading(), older)).toEqual(reading());
    const newer = reading({ fetchedAt: "2026-09-23T08:30:00.000Z", cached: true });
    expect(mergeUsage(reading(), newer)).toBe(newer);
    expect(mergeUsage(undefined, older)).toBe(older);
  });
});

describe("retryDelayMs", () => {
  it("reads seconds and dates, within sane bounds", () => {
    const now = Date.parse("2026-09-23T08:00:00Z");
    expect(retryDelayMs("120", now)).toBe(120_000);
    expect(retryDelayMs("1", now)).toBe(30_000);
    expect(retryDelayMs("86400", now)).toBe(30 * 60_000);
    expect(retryDelayMs("Wed, 23 Sep 2026 08:05:00 GMT", now)).toBe(5 * 60_000);
    expect(retryDelayMs(null, now)).toBe(2 * 60_000);
    expect(retryDelayMs("soon", now)).toBe(2 * 60_000);
  });
});

describe("SwitchGuard", () => {
  it("counts only moves that happened, within the window", () => {
    const guard = new SwitchGuard(2, 10_000);
    expect(guard.allows("a", 0)).toBe(true);
    guard.note("a", 0);
    guard.note("a", 1_000);
    expect(guard.allows("a", 2_000)).toBe(false);
    expect(guard.allows("b", 2_000)).toBe(true);
    expect(guard.allows("a", 10_500)).toBe(true);
    guard.forget("a");
    expect(guard.allows("a", 2_000)).toBe(true);
  });
});

describe("parseGoUsage", () => {
  it("reads the rolling, weekly and monthly windows the endpoint reports", () => {
    const windows = parseGoUsage({
      usage: {
        rolling: { status: "ok", percent: 0, resetsAt: "2026-10-16T20:07:15.000Z" },
        weekly: { status: "ok", percent: 65, resetsAt: "2026-10-19T00:00:00.000Z" },
        monthly: { status: "ok", percent: 66, resetsAt: "2026-11-01T11:28:42.000Z" },
      },
    });
    expect(windows).toEqual([
      { id: "rolling", label: "5-hour", usedPercent: 0, resetsAt: "2026-10-16T20:07:15.000Z" },
      { id: "weekly", label: "Weekly", usedPercent: 65, resetsAt: "2026-10-19T00:00:00.000Z" },
      { id: "monthly", label: "Monthly", usedPercent: 66, resetsAt: "2026-11-01T11:28:42.000Z" },
    ]);
  });

  it("shows a rate-limited window as full, so routing treats the account as out until it resets", () => {
    const windows = parseGoUsage({
      usage: { rolling: { status: "rate-limited", percent: 78, resetsAt: "2026-10-16T20:00:00.000Z" } },
    });
    expect(windows).toEqual([{ id: "rolling", label: "5-hour", usedPercent: 100, resetsAt: "2026-10-16T20:00:00.000Z" }]);
  });

  it("skips windows that carry no number, and shapes it doesn't know", () => {
    expect(parseGoUsage(null)).toEqual([]);
    expect(parseGoUsage({})).toEqual([]);
    expect(parseGoUsage({ usage: {} })).toEqual([]);
    expect(parseGoUsage({ usage: { weekly: { percent: "65" }, rolling: { status: "ok" } } })).toEqual([]);
  });

  it("clamps odd values and tolerates missing or unparseable reset times", () => {
    expect(parseGoUsage({ usage: { monthly: { percent: 150, resetsAt: "not a date" } } })).toEqual([
      { id: "monthly", label: "Monthly", usedPercent: 100, resetsAt: null },
    ]);
    expect(parseGoUsage({ usage: { weekly: { percent: -3 } } })).toEqual([
      { id: "weekly", label: "Weekly", usedPercent: 0, resetsAt: null },
    ]);
  });
});
