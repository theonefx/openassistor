/**
 * Deterministic time utilities for schedule management.
 *
 * All time operations are done with explicit timezone handling.
 * No fuzzy natural language parsing — the LLM provides ISO-8601 strings,
 * and this module handles timezone conversion, date arithmetic, and
 * formatting deterministically.
 */

// ============================================================================
// Date formatting with timezone
// ============================================================================

/**
 * Format a Date object to a localized string in the given timezone.
 */
export function formatDateTime(date: Date, timezone: string): string {
  return date.toLocaleString("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
}

export function formatDate(date: Date, timezone: string): string {
  return date.toLocaleDateString("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
}

export function formatTime(date: Date, timezone: string): string {
  return date.toLocaleTimeString("zh-CN", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ============================================================================
// Date range helpers
// ============================================================================

/**
 * Get today's date string (YYYY-MM-DD) in the given timezone.
 */
export function getTodayDateStr(timezone: string): string {
  return getDateStr(new Date(), timezone);
}

/**
 * Get date string (YYYY-MM-DD) for a Date in the given timezone.
 */
export function getDateStr(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((p) => p.type === "year")?.value ?? "";
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  return `${year}-${month}-${day}`;
}

/**
 * Get the date range for "this week" (Monday to Sunday) in the given timezone.
 */
export function getWeekRange(timezone: string): { start: string; end: string } {
  const now = new Date();
  const todayStr = getDateStr(now, timezone);

  // Get day of week in the configured timezone
  const dayOfWeekStr = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(now);
  const dayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const dayOfWeek = dayMap[dayOfWeekStr] ?? 0;

  // Calculate Monday offset
  const mondayOffset = -((dayOfWeek + 6) % 7);
  const today = new Date(todayStr + "T12:00:00Z");
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() + mondayOffset);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  return {
    start: monday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10),
  };
}

/**
 * Get the date range for "this month" in the given timezone.
 */
export function getMonthRange(timezone: string): { start: string; end: string } {
  const now = new Date();
  const todayStr = getDateStr(now, timezone);
  const [year, month] = todayStr.split("-").map(Number);
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { start, end };
}

// ============================================================================
// Recurrence helpers
// ============================================================================

/**
 * Convert a recurrence rule to a human-readable description.
 */
export function describeRecurrence(
  rule: { kind: string; dayOfWeek?: number[]; dayOfMonth?: number; cronExpr?: string },
): string {
  switch (rule.kind) {
    case "none":
      return "one-time";
    case "daily":
      return "every day";
    case "weekly": {
      if (rule.dayOfWeek && rule.dayOfWeek.length > 0) {
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const days = rule.dayOfWeek.map((d) => dayNames[d] ?? `day${d}`).join(", ");
        return `weekly on ${days}`;
      }
      return "every week";
    }
    case "monthly":
      return rule.dayOfMonth ? `monthly on day ${rule.dayOfMonth}` : "every month";
    case "yearly":
      return "every year";
    case "weekdays":
      return "every weekday (Mon-Fri)";
    case "custom":
      return `custom: ${rule.cronExpr ?? "?"}`;
    default:
      return rule.kind;
  }
}

/**
 * Extract hours and minutes from a Date in the given timezone.
 */
function getTimeInTimezone(date: Date, timezone: string): { hours: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(date);
  const hours = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minutes = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return { hours, minutes };
}

/**
 * Convert a recurrence rule to a cron expression for the cron service.
 * Returns null for one-time events (use "at" schedule instead).
 */
export function recurrenceToCronExpr(
  rule: { kind: string; dayOfWeek?: number[]; dayOfMonth?: number; cronExpr?: string },
  startTime: Date,
  timezone: string,
): string | null {
  const { hours, minutes } = getTimeInTimezone(startTime, timezone);

  switch (rule.kind) {
    case "none":
      return null;
    case "daily":
      return `${minutes} ${hours} * * *`;
    case "weekly": {
      const days = rule.dayOfWeek?.join(",") ?? String(startTime.getDay());
      return `${minutes} ${hours} * * ${days}`;
    }
    case "monthly": {
      const day = rule.dayOfMonth ?? startTime.getDate();
      return `${minutes} ${hours} ${day} * *`;
    }
    case "yearly": {
      const month = startTime.getMonth() + 1;
      const day = startTime.getDate();
      return `${minutes} ${hours} ${day} ${month} *`;
    }
    case "weekdays":
      return `${minutes} ${hours} * * 1-5`;
    case "custom":
      return rule.cronExpr ?? null;
    default:
      return null;
  }
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate an ISO-8601 datetime string.
 * Returns the parsed Date or null if invalid.
 */
export function parseISO(input: string): Date | null {
  const date = new Date(input);
  if (isNaN(date.getTime())) return null;
  return date;
}

/**
 * Check if a datetime string represents a time in the past.
 */
export function isInPast(datetime: string): boolean {
  const date = new Date(datetime);
  return date.getTime() < Date.now();
}
