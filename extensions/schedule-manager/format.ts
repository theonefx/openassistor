/**
 * Markdown format parser and serializer — aligned with the summary project.
 *
 * Document format:
 * ```markdown
 * # Project
 *
 * ## Module
 *
 * ### Sub-module
 * - [ ] **Task title** @assignee `id:xxxxxxxx`
 *     > note line (blockquote, append-only)
 *     > ⏱ 2026-04-08 10:00 ~ 30min | weekdays | remind:15min
 *     - [x] completed sub-task @person
 *     - [->] 进度：150/300
 *     - [->] 【4/8 跟进】follow up action
 *     - [ ] pending sub-task
 *
 * ---
 *
 * # Another Project
 * ```
 *
 * Status notation:
 * - `[ ]`  = todo
 * - `[->]` = stage-complete (阶段完成)
 * - `[x]`  = completed
 * - `[~]`  = cancelled
 */

import type {
  TaskItem, SubItem, Section, TaskDocument, TaskStatus,
  ScheduleInfo, RecurrenceRule,
} from "./types.js";

// ============================================================================
// Timezone helpers (self-contained, no dependency on time-utils.ts)
// ============================================================================

/** Get YYYY-MM-DD in a specific timezone. */
function getDateStrInTimezone(date: Date, timezone?: string): string {
  if (!timezone) return date.toISOString().slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const d = parts.find((p) => p.type === "day")?.value ?? "";
  return `${y}-${m}-${d}`;
}

/** Get HH:mm in a specific timezone. */
function getTimeStrInTimezone(date: Date, timezone?: string): { hours: string; minutes: string } {
  if (!timezone) {
    return {
      hours: String(date.getUTCHours()).padStart(2, "0"),
      minutes: String(date.getUTCMinutes()).padStart(2, "0"),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour: "numeric", minute: "numeric", hour12: false,
  }).formatToParts(date);
  return {
    hours: (parts.find((p) => p.type === "hour")?.value ?? "00").padStart(2, "0"),
    minutes: (parts.find((p) => p.type === "minute")?.value ?? "00").padStart(2, "0"),
  };
}

/**
 * Parse "YYYY-MM-DD" + "HH:mm" in a given timezone to an ISO string.
 * Falls back to local interpretation if timezone is not provided.
 */
function parseDateTimeInTimezone(dateStr: string, timeStr: string, timezone?: string): string {
  if (!timezone) {
    return new Date(`${dateStr}T${timeStr}:00`).toISOString();
  }
  // Create a reference date in the target timezone by iterating to find the offset
  // Use a simple approach: create the date as UTC, then adjust
  const naive = new Date(`${dateStr}T${timeStr}:00Z`);
  // Get what this UTC time looks like in the target timezone
  const tzParts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour: "numeric", minute: "numeric", hour12: false,
    year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(naive);
  const tzHour = parseInt(tzParts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const tzMinute = parseInt(tzParts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const tzDay = parseInt(tzParts.find((p) => p.type === "day")?.value ?? "1", 10);
  const naiveHour = parseInt(timeStr.split(":")[0], 10);
  const naiveMinute = parseInt(timeStr.split(":")[1], 10);
  const naiveDay = parseInt(dateStr.split("-")[2], 10);

  // Calculate offset: (tz representation) - (what we wanted) tells us the timezone offset
  let diffMinutes = (tzHour * 60 + tzMinute) - (naiveHour * 60 + naiveMinute);
  diffMinutes += (tzDay - naiveDay) * 24 * 60;
  // The actual UTC time = naive UTC - diffMinutes
  const actualUtc = new Date(naive.getTime() - diffMinutes * 60_000);
  return actualUtc.toISOString();
}

// ============================================================================
// Parse helpers
// ============================================================================

function parseCheckbox(raw: string): TaskStatus {
  const s = raw.trim();
  if (s === "x") return "completed";
  if (s === "->" || s === ">") return "stage-complete";
  if (s === "~") return "cancelled";
  return "todo";
}

function checkboxStr(status: TaskStatus): string {
  switch (status) {
    case "completed": return "[x]";
    case "stage-complete": return "[->]";
    case "cancelled": return "[~]";
    default: return "[ ]";
  }
}

/**
 * Parse a top-level task header line.
 *
 * Formats:
 *   - [ ] Title `id:xxx`
 *   - [ ] **Title** @person `id:xxx`
 *   - [ ] ⏰ **Title** @person `id:xxx`
 */
function parseTaskHeader(line: string): {
  status: TaskStatus;
  title: string;
  important: boolean;
  assignee?: string;
  id: string;
  todayMarker: boolean;
} | null {
  // Match: - [status] rest
  const m = line.match(/^- \[([^\]]*)\]\s+(.+)$/);
  if (!m) return null;

  const status = parseCheckbox(m[1]);
  let rest = m[2];

  // ⏰ marker (handle optional variation selector U+FE0F)
  let todayMarker = false;
  if (rest.match(/^⏰\uFE0F?\s*/)) {
    todayMarker = true;
    rest = rest.replace(/^⏰\uFE0F?\s*/, "");
  }

  // Extract `id:xxx`
  let id = "";
  const idMatch = rest.match(/\s*`id:([a-f0-9]+)`/);
  if (idMatch) {
    id = idMatch[1];
    rest = rest.replace(/\s*`id:[a-f0-9]+`/, "").trim();
  }

  // Extract @assignee (at end of line, before id was stripped)
  let assignee: string | undefined;
  const assigneeMatch = rest.match(/\s+@(\S+)$/);
  if (assigneeMatch) {
    assignee = assigneeMatch[1];
    rest = rest.replace(/\s+@\S+$/, "").trim();
  }

  // Check **bold** (important)
  let important = false;
  const boldMatch = rest.match(/^\*\*(.+?)\*\*$/);
  if (boldMatch) {
    important = true;
    rest = boldMatch[1];
  }

  return { status, title: rest, important, assignee, id, todayMarker };
}

/**
 * Parse a sub-item line (indented under a task).
 *
 * Types:
 *   - `> text`            → note
 *   - `- [status] text`   → sub-task
 *   - `- [->] 进度：N/M`  → progress
 */
function parseSubItemLine(line: string): SubItem | null {
  const trimmed = line.trim();

  // Blockquote note
  if (trimmed.startsWith(">")) {
    const text = trimmed.slice(1).trimStart();
    return { kind: "note", text };
  }

  // Checkbox sub-item
  const m = trimmed.match(/^- \[([^\]]*)\]\s+(.+)$/);
  if (m) {
    const status = parseCheckbox(m[1]);
    let text = m[2];

    // Check for progress pattern
    const progressMatch = text.match(/^进度[：:]\s*(\d+)\s*\/\s*(\d+)/);
    if (progressMatch) {
      return {
        kind: "progress",
        current: parseInt(progressMatch[1], 10),
        total: parseInt(progressMatch[2], 10),
      };
    }

    // Extract @assignee
    let assignee: string | undefined;
    const assigneeMatch = text.match(/\s+@(\S+)$/);
    if (assigneeMatch) {
      assignee = assigneeMatch[1];
      text = text.replace(/\s+@\S+$/, "").trim();
    }

    return { kind: "task", status, text, assignee };
  }

  return null;
}

// ============================================================================
// Schedule metadata in blockquote
// ============================================================================

/**
 * Parse schedule info from a note line starting with ⏱.
 *
 * Format: ⏱ 2026-04-08 10:00 ~ 30min | weekdays | remind:15min | cron:job-xxx
 * Or:     ⏱ 10:00 ~ 30min | weekdays | remind:15min
 */
export function parseScheduleNote(text: string, timezone?: string): ScheduleInfo | null {
  if (!text.match(/^⏱\uFE0F?\s/)) return null;
  const rest = text.replace(/^⏱\uFE0F?\s*/, "");

  // Split by |
  const parts = rest.split("|").map((p) => p.trim());
  if (parts.length === 0) return null;

  // First part: time info "YYYY-MM-DD HH:mm ~ Nmin" or "HH:mm ~ Nmin"
  const timePart = parts[0];
  const timeMatch = timePart.match(
    /^(?:(\d{4}-\d{2}-\d{2})\s+)?(\d{2}:\d{2})\s*~\s*(\d+)\s*min$/,
  );
  if (!timeMatch) return null;

  const dateStr = timeMatch[1] || getDateStrInTimezone(new Date(), timezone);
  const timeStr = timeMatch[2];
  const durationMinutes = parseInt(timeMatch[3], 10);
  // Parse time in the configured timezone by constructing an offset-aware string
  const startTime = parseDateTimeInTimezone(dateStr, timeStr, timezone);

  // Parse remaining parts
  let recurrence: RecurrenceRule = { kind: "none" };
  let reminderMinutes = 0;
  let cronJobId: string | undefined;

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];

    // remind:Nmin
    const remindMatch = part.match(/^remind:(\d+)\s*min$/);
    if (remindMatch) {
      reminderMinutes = parseInt(remindMatch[1], 10);
      continue;
    }

    // cron:job-id
    const cronMatch = part.match(/^cron:(.+)$/);
    if (cronMatch) {
      cronJobId = cronMatch[1].trim();
      continue;
    }

    // Recurrence
    recurrence = parseRecurrenceToken(part);
  }

  return { startTime, durationMinutes, recurrence, reminderMinutes, cronJobId };
}

function parseRecurrenceToken(token: string): RecurrenceRule {
  const t = token.trim();
  if (t === "daily") return { kind: "daily" };
  if (t === "weekdays") return { kind: "weekdays" };
  if (t === "weekly") return { kind: "weekly" };
  if (t === "monthly") return { kind: "monthly" };
  if (t === "yearly") return { kind: "yearly" };

  const weeklyMatch = t.match(/^weekly\(([0-6,]+)\)$/);
  if (weeklyMatch) {
    return { kind: "weekly", dayOfWeek: weeklyMatch[1].split(",").map(Number) };
  }
  const monthlyMatch = t.match(/^monthly\((\d+)\)$/);
  if (monthlyMatch) {
    return { kind: "monthly", dayOfMonth: Number(monthlyMatch[1]) };
  }
  const cronMatch = t.match(/^cron\((.+)\)$/);
  if (cronMatch) {
    return { kind: "custom", cronExpr: cronMatch[1] };
  }

  return { kind: "none" };
}

// ============================================================================
// Main parser
// ============================================================================

export function parseDocument(content: string, timezone?: string): TaskDocument {
  const lines = content.split("\n");
  const doc: TaskDocument = { sections: [] };

  // Track heading hierarchy via a stack
  const sectionStack: Array<{ level: number; section: Section }> = [];
  let currentTask: TaskItem | null = null;

  function finishTask() {
    if (!currentTask) return;
    // Attach to the deepest section
    if (sectionStack.length > 0) {
      sectionStack[sectionStack.length - 1].section.tasks.push(currentTask);
    }
    currentTask = null;
  }

  function getSectionsForLevel(level: number): Section[] {
    // Pop sections at same or deeper level
    while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1].level >= level) {
      sectionStack.pop();
    }
    if (sectionStack.length === 0) return doc.sections;
    return sectionStack[sectionStack.length - 1].section.sections;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // --- Heading ---
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      finishTask();
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();
      const section: Section = { level, title, tasks: [], sections: [] };
      const parent = getSectionsForLevel(level);
      parent.push(section);
      sectionStack.push({ level, section });
      continue;
    }

    // --- Separator ---
    if (line.match(/^---+$/)) {
      finishTask();
      continue;
    }

    // --- Top-level task (not indented) ---
    if (line.match(/^- \[/)) {
      finishTask();
      const parsed = parseTaskHeader(line);
      if (parsed) {
        currentTask = {
          id: parsed.id,
          title: parsed.title,
          status: parsed.status,
          important: parsed.important,
          assignee: parsed.assignee,
          todayMarker: parsed.todayMarker,
          notes: [],
          subItems: [],
        };
      }
      continue;
    }

    // --- Indented content (sub-items of current task) ---
    if (currentTask && line.match(/^(\s{2,}|\t)/)) {
      const subItem = parseSubItemLine(line);
      if (subItem) {
        if (subItem.kind === "note") {
          // Check if it's schedule metadata
          const scheduleInfo = parseScheduleNote(subItem.text, timezone);
          if (scheduleInfo) {
            currentTask.schedule = scheduleInfo;
          } else {
            currentTask.notes.push(subItem.text);
          }
        } else if (subItem.kind === "progress") {
          // Store as both a sub-item and on the task directly
          currentTask.subItems.push(subItem);
        } else {
          currentTask.subItems.push(subItem);
        }
      }
      continue;
    }

    // Empty lines — don't break task context
    if (line.trim() === "") continue;
  }

  finishTask();
  return doc;
}

// ============================================================================
// Serialize helpers
// ============================================================================

function serializeRecurrence(rule: RecurrenceRule): string {
  switch (rule.kind) {
    case "none": return "";
    case "daily": return "daily";
    case "weekdays": return "weekdays";
    case "weekly":
      return rule.dayOfWeek?.length ? `weekly(${rule.dayOfWeek.join(",")})` : "weekly";
    case "monthly":
      return rule.dayOfMonth ? `monthly(${rule.dayOfMonth})` : "monthly";
    case "yearly": return "yearly";
    case "custom": return `cron(${rule.cronExpr})`;
    default: return "";
  }
}

function serializeScheduleNote(s: ScheduleInfo, timezone?: string): string {
  const d = new Date(s.startTime);
  const dateStr = getDateStrInTimezone(d, timezone);
  const { hours, minutes } = getTimeStrInTimezone(d, timezone);
  const parts = [`⏱ ${dateStr} ${hours}:${minutes} ~ ${s.durationMinutes}min`];

  const recStr = serializeRecurrence(s.recurrence);
  if (recStr) parts.push(recStr);
  if (s.reminderMinutes > 0) parts.push(`remind:${s.reminderMinutes}min`);
  if (s.cronJobId) parts.push(`cron:${s.cronJobId}`);

  return parts.join(" | ");
}

function serializeTaskItem(task: TaskItem, timezone?: string, indent: string = ""): string {
  const lines: string[] = [];

  // Header line
  const marker = task.todayMarker ? "⏰ " : "";
  const bold = task.important ? `**${task.title}**` : task.title;
  const assignee = task.assignee ? ` @${task.assignee}` : "";
  const idTag = task.id ? ` \`id:${task.id}\`` : "";
  lines.push(`${indent}- ${checkboxStr(task.status)} ${marker}${bold}${assignee}${idTag}`);

  const sub = indent + "    ";

  // Notes (blockquotes)
  for (const note of task.notes) {
    lines.push(`${sub}> ${note}`);
  }

  // Schedule metadata (as a special note)
  if (task.schedule) {
    lines.push(`${sub}> ${serializeScheduleNote(task.schedule, timezone)}`);
  }

  // Sub-items
  for (const item of task.subItems) {
    if (item.kind === "task") {
      const a = item.assignee ? ` @${item.assignee}` : "";
      lines.push(`${sub}- ${checkboxStr(item.status)} ${item.text}${a}`);
    } else if (item.kind === "progress") {
      lines.push(`${sub}- [->] 进度：${item.current}/${item.total}`);
    }
  }

  return lines.join("\n");
}

function serializeSection(section: Section, timezone?: string, depth: number = 0): string {
  const lines: string[] = [];
  const prefix = "#".repeat(section.level);
  lines.push(`${prefix} ${section.title}`);

  // Tasks under this section
  for (const task of section.tasks) {
    lines.push(serializeTaskItem(task, timezone));
  }

  // Nested sections
  for (const child of section.sections) {
    lines.push("");
    lines.push(serializeSection(child, timezone, depth + 1));
  }

  return lines.join("\n");
}

// ============================================================================
// Main serializer
// ============================================================================

export function serializeDocument(doc: TaskDocument, timezone?: string): string {
  const parts: string[] = [];

  for (let i = 0; i < doc.sections.length; i++) {
    if (i > 0) {
      parts.push("");
      parts.push("---");
      parts.push("");
    }
    parts.push(serializeSection(doc.sections[i], timezone));
  }

  return parts.join("\n") + "\n";
}

// ============================================================================
// Document query utilities
// ============================================================================

/** Find a task by ID anywhere in the document. */
export function findTaskById(doc: TaskDocument, id: string): TaskItem | null {
  function searchSections(sections: Section[]): TaskItem | null {
    for (const section of sections) {
      for (const task of section.tasks) {
        if (task.id === id) return task;
      }
      const found = searchSections(section.sections);
      if (found) return found;
    }
    return null;
  }
  return searchSections(doc.sections);
}

/** Collect all tasks in the document. */
export function allTasks(doc: TaskDocument): TaskItem[] {
  const result: TaskItem[] = [];
  function collect(sections: Section[]) {
    for (const section of sections) {
      result.push(...section.tasks);
      collect(section.sections);
    }
  }
  collect(doc.sections);
  return result;
}

/** Get the heading path for a task (e.g., ["Pandora", "SAR 包发布", "2026-04-release"]). */
export function getTaskPath(doc: TaskDocument, id: string): string[] {
  function search(sections: Section[], path: string[]): string[] | null {
    for (const section of sections) {
      const current = [...path, section.title];
      for (const task of section.tasks) {
        if (task.id === id) return current;
      }
      const found = search(section.sections, current);
      if (found) return found;
    }
    return null;
  }
  return search(doc.sections, []) || [];
}

/**
 * Find or create the section hierarchy for a task insertion.
 * Returns the section where the task should be added.
 */
export function ensureSection(
  doc: TaskDocument,
  project: string,
  module?: string,
  subModule?: string,
): Section {
  // Find or create level-1 section
  let l1 = doc.sections.find((s) => s.title === project);
  if (!l1) {
    l1 = { level: 1, title: project, tasks: [], sections: [] };
    doc.sections.push(l1);
  }

  if (!module) return l1;

  // Find or create level-2 section
  let l2 = l1.sections.find((s) => s.title === module);
  if (!l2) {
    l2 = { level: 2, title: module, tasks: [], sections: [] };
    l1.sections.push(l2);
  }

  if (!subModule) return l2;

  // Find or create level-3 section
  let l3 = l2.sections.find((s) => s.title === subModule);
  if (!l3) {
    l3 = { level: 3, title: subModule, tasks: [], sections: [] };
    l2.sections.push(l3);
  }

  return l3;
}

/**
 * Remove a task by ID from the document.
 * Returns true if the task was found and removed.
 */
export function removeTaskById(doc: TaskDocument, id: string): boolean {
  function removeFrom(sections: Section[]): boolean {
    for (const section of sections) {
      const idx = section.tasks.findIndex((t) => t.id === id);
      if (idx !== -1) {
        section.tasks.splice(idx, 1);
        return true;
      }
      if (removeFrom(section.sections)) return true;
    }
    return false;
  }
  return removeFrom(doc.sections);
}
