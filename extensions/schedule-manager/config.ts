export type ScheduleConfig = {
  dataDir: string;
  timezone: string;
  defaultReminderMinutes: number;
  /** Inject today's schedule into agent context on conversation start */
  injectTodaySchedule: boolean;
  /** Number of recent daily files to read for context in daily_plan */
  historyDays: number;
};

const DEFAULTS: ScheduleConfig = {
  dataDir: "~/.openassistor/schedule",
  timezone: "Asia/Shanghai",
  defaultReminderMinutes: 15,
  injectTodaySchedule: true,
  historyDays: 7,
};

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
  }
}

export const scheduleConfigSchema = {
  parse(value: unknown): ScheduleConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ...DEFAULTS };
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      ["dataDir", "timezone", "defaultReminderMinutes", "injectTodaySchedule", "historyDays"],
      "schedule config",
    );
    return {
      dataDir: typeof cfg.dataDir === "string" ? cfg.dataDir : DEFAULTS.dataDir,
      timezone: typeof cfg.timezone === "string" ? cfg.timezone : DEFAULTS.timezone,
      defaultReminderMinutes:
        typeof cfg.defaultReminderMinutes === "number"
          ? Math.max(0, Math.floor(cfg.defaultReminderMinutes))
          : DEFAULTS.defaultReminderMinutes,
      injectTodaySchedule:
        typeof cfg.injectTodaySchedule === "boolean"
          ? cfg.injectTodaySchedule
          : DEFAULTS.injectTodaySchedule,
      historyDays:
        typeof cfg.historyDays === "number"
          ? Math.max(1, Math.floor(cfg.historyDays))
          : DEFAULTS.historyDays,
    };
  },
};
