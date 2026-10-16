import { join } from "node:path";
import { UsageSchema, type Usage, type UsageWindow } from "../shared/model";
import { readJson, writeJsonAtomic } from "./json-file";
import { dataDir } from "./paths";

/** How close a limit notice's reset time must be to a window's for that window to be the full one. */
const MATCH_MS = 20 * 60_000;

/** How long to wait after the provider asks us to slow down (HTTP 429), from its `Retry-After`. */
export function retryDelayMs(retryAfter: string | null, now: number = Date.now()): number {
  const fallback = 2 * 60_000;
  if (!retryAfter) return fallback;
  const seconds = Number(retryAfter);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(retryAfter) - now;
  if (!Number.isFinite(ms)) return fallback;
  return Math.min(30 * 60_000, Math.max(30_000, ms));
}

/**
 * The reading with the window a limit notice is about shown as full, since the notice is the
 * freshest word on usage there is. That window is the one resetting when the notice says it will;
 * when several do, the fullest one.
 */
export function showLimit(usage: Usage, resetsAt: string | null): Usage {
  const at = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  if (!Number.isFinite(at)) return usage;
  let match = -1;
  for (const [index, window] of usage.windows.entries()) {
    if (!window.resetsAt || Math.abs(Date.parse(window.resetsAt) - at) > MATCH_MS) continue;
    if (match < 0 || window.usedPercent > (usage.windows[match]?.usedPercent ?? 0)) match = index;
  }
  if (match < 0) return usage;
  return {
    ...usage,
    windows: usage.windows.map((window, index) => (index === match ? { ...window, usedPercent: Math.max(100, window.usedPercent) } : window)),
  };
}

/**
 * The reading to show after a refresh. A failed or rate-limited refresh keeps the last windows, and
 * the CLI's own cached copy only replaces a reading it is newer than.
 */
export function mergeUsage(previous: Usage | undefined, next: Usage): Usage {
  if (!previous || previous.windows.length === 0) return next;
  if (next.windows.length === 0) return { ...previous, error: next.error };
  if (next.cached && Date.parse(next.fetchedAt) <= Date.parse(previous.fetchedAt)) return previous;
  return next;
}

/** OpenCode Go's windows, in the order to show them. */
const GO_WINDOWS: ReadonlyArray<readonly [key: string, label: string]> = [
  ["rolling", "5-hour"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
];

/**
 * The windows from OpenCode Go's usage endpoint, whose `percent` is already 0–100 per rolling,
 * weekly and monthly allowance. A window the provider has marked `rate-limited` is shown as full,
 * so routing treats the account as out until it resets.
 */
export function parseGoUsage(body: unknown): UsageWindow[] {
  const usage = (body as { usage?: unknown } | null | undefined)?.usage;
  if (!usage || typeof usage !== "object") return [];
  const windows: UsageWindow[] = [];
  for (const [key, label] of GO_WINDOWS) {
    const entry = (usage as Record<string, unknown>)[key];
    if (!entry || typeof entry !== "object") continue;
    const { percent, resetsAt, status } = entry as { percent?: unknown; resetsAt?: unknown; status?: unknown };
    if (typeof percent !== "number" || !Number.isFinite(percent)) continue;
    const used = Math.min(100, Math.max(0, percent));
    windows.push({
      id: key,
      label,
      usedPercent: status === "rate-limited" ? Math.max(100, used) : used,
      resetsAt: isoDate(resetsAt),
    });
  }
  return windows;
}

/** An ISO timestamp, whatever shape the provider sent, or null. */
function isoDate(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function usagePath(): string {
  return join(dataDir(), "usage.json");
}

/** Each account's last reading, as `saveReadings` left it, so a reload never blanks the cards. */
export async function loadReadings(): Promise<Map<string, Usage>> {
  const readings = new Map<string, Usage>();
  const saved = await readJson(usagePath()).catch(() => undefined);
  if (!saved || typeof saved !== "object") return readings;
  for (const [accountId, value] of Object.entries(saved)) {
    const parsed = UsageSchema.safeParse(value);
    if (parsed.success) readings.set(accountId, parsed.data);
  }
  return readings;
}

export function saveReadings(readings: ReadonlyMap<string, Usage>): Promise<void> {
  return writeJsonAtomic(usagePath(), Object.fromEntries(readings));
}
