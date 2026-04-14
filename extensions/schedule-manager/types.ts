/**
 * Unified task types for the schedule-manager plugin.
 *
 * Supports both calendar events (time-specific meetings/appointments)
 * and work item tracking (project tasks with lifecycle management).
 *
 * Format alignment: matches the summary project's daily/weekly format.
 */

// ---------------------------------------------------------------------------
// Task status — aligned with summary project checkbox notation
// ---------------------------------------------------------------------------

/** `[ ]` = todo, `[->]` = stage-complete, `[x]` = completed, `[~]` = cancelled */
export type TaskStatus = "todo" | "stage-complete" | "completed" | "cancelled";

// ---------------------------------------------------------------------------
// Calendar / schedule types
// ---------------------------------------------------------------------------

export type RecurrenceRule =
  | { kind: "none" }
  | { kind: "daily" }
  | { kind: "weekly"; dayOfWeek?: number[] }
  | { kind: "monthly"; dayOfMonth?: number }
  | { kind: "yearly" }
  | { kind: "weekdays" }
  | { kind: "custom"; cronExpr: string };

/** Time-specific scheduling info (optional — work items may not have this). */
export type ScheduleInfo = {
  /** ISO-8601 datetime with timezone offset */
  startTime: string;
  durationMinutes: number;
  recurrence: RecurrenceRule;
  /** Minutes before start for reminder. 0 = no reminder. */
  reminderMinutes: number;
  /** Linked cron job ID for the reminder */
  cronJobId?: string;
};

// ---------------------------------------------------------------------------
// Sub-items (nested content under a task)
// ---------------------------------------------------------------------------

export type SubItem =
  | { kind: "note"; text: string }
  | { kind: "task"; status: TaskStatus; text: string; assignee?: string }
  | { kind: "progress"; current: number; total: number };

// ---------------------------------------------------------------------------
// Task item
// ---------------------------------------------------------------------------

export type TaskItem = {
  id: string;
  title: string;
  status: TaskStatus;
  /** `**bold**` = important/priority */
  important: boolean;
  /** `@person` assignment */
  assignee?: string;
  /** `⏰` prefix — today has a scheduled follow-up */
  todayMarker: boolean;
  /** Calendar info (meetings, appointments with specific times) */
  schedule?: ScheduleInfo;
  /** `>` blockquote lines (append-only notes) */
  notes: string[];
  /** Sub-tasks, progress items */
  subItems: SubItem[];
  tags?: string[];
};

// ---------------------------------------------------------------------------
// Document structure (hierarchical sections)
// ---------------------------------------------------------------------------

/** A heading-based section (# / ## / ###) */
export type Section = {
  level: number;
  title: string;
  /** Tasks directly under this section */
  tasks: TaskItem[];
  /** Nested sub-sections */
  sections: Section[];
};

/** A parsed markdown document (daily file, calendar file, etc.) */
export type TaskDocument = {
  sections: Section[];
};

// ---------------------------------------------------------------------------
// Input / patch types for CRUD operations
// ---------------------------------------------------------------------------

export type TaskAddInput = {
  title: string;
  /** Target `#` heading (project) */
  project: string;
  /** Target `##` heading (module) */
  module?: string;
  /** Target `###` heading (sub-module) */
  subModule?: string;
  important?: boolean;
  assignee?: string;
  notes?: string[];
  schedule?: {
    startTime: string;
    durationMinutes?: number;
    recurrence?: RecurrenceRule;
    reminderMinutes?: number;
  };
  subItems?: Array<{
    kind: "note" | "task";
    text: string;
    status?: TaskStatus;
    assignee?: string;
  }>;
  tags?: string[];
};

export type TaskPatch = {
  title?: string;
  status?: TaskStatus;
  important?: boolean;
  assignee?: string;
  todayMarker?: boolean;
  /** Append new note lines */
  addNotes?: string[];
  /** Append new sub-items */
  addSubItems?: SubItem[];
  /** Replace schedule info */
  schedule?: ScheduleInfo;
  /** Shortcut: set schedule.cronJobId without replacing entire schedule */
  cronJobId?: string;
  /** Set/update progress */
  progress?: { current: number; total: number };
};
