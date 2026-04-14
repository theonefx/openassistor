/**
 * Storage layer for the schedule-manager plugin.
 *
 * Manages three types of files:
 * - daily/YYYY-MM-DD.md   — Daily work logs (primary data source)
 * - weekly/YYYY-MM-DD.md  — Weekly reports (named by Friday date)
 * - calendar.md           — Time-specific events (meetings, reminders)
 *
 * Daily files follow the summary project format with hierarchical sections.
 * Calendar events are flat-listed with schedule metadata in blockquote notes.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  parseDocument,
  serializeDocument,
  findTaskById,
  allTasks,
  ensureSection,
  removeTaskById,
} from "./format.js";
import type {
  TaskItem, TaskDocument, TaskAddInput, TaskPatch,
  SubItem,
} from "./types.js";

// ============================================================================
// Store
// ============================================================================

export class ScheduleStore {
  private baseDir: string;
  private dailyDir: string;
  private weeklyDir: string;
  private archivedDir: string;
  private calendarPath: string;
  private timezone: string;

  constructor(dataDir: string, timezone: string) {
    this.timezone = timezone;
    const resolved = dataDir.replace(/^~/, process.env.HOME || "");
    this.baseDir = resolved;
    this.dailyDir = path.join(resolved, "daily");
    this.weeklyDir = path.join(resolved, "weekly");
    this.archivedDir = path.join(resolved, "weekly", "archived");
    this.calendarPath = path.join(resolved, "calendar.md");

    // Ensure directories exist
    for (const dir of [this.dailyDir, this.weeklyDir, this.archivedDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  // --------------------------------------------------------------------------
  // Path helpers
  // --------------------------------------------------------------------------

  get paths() {
    return {
      base: this.baseDir,
      daily: this.dailyDir,
      weekly: this.weeklyDir,
      calendar: this.calendarPath,
    };
  }

  private dailyFilePath(dateStr: string): string {
    return path.join(this.dailyDir, `${dateStr}.md`);
  }

  private weeklyFilePath(dateStr: string): string {
    return path.join(this.weeklyDir, `${dateStr}.md`);
  }

  // --------------------------------------------------------------------------
  // ID generation
  // --------------------------------------------------------------------------

  generateId(existingDoc?: TaskDocument): string {
    const existing = existingDoc ? allTasks(existingDoc).map((t) => t.id) : [];
    let id: string;
    do {
      id = randomUUID().slice(0, 8);
    } while (existing.includes(id));
    return id;
  }

  // --------------------------------------------------------------------------
  // File I/O
  // --------------------------------------------------------------------------

  private readFile(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }

  private writeFile(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, "utf-8");
  }

  // --------------------------------------------------------------------------
  // Daily file operations
  // --------------------------------------------------------------------------

  /** Read and parse a daily file. Returns null if file doesn't exist. */
  readDaily(dateStr: string): TaskDocument | null {
    const content = this.readFile(this.dailyFilePath(dateStr));
    if (!content) return null;
    return parseDocument(content, this.timezone);
  }

  /** Read raw content of a daily file. */
  readDailyRaw(dateStr: string): string | null {
    return this.readFile(this.dailyFilePath(dateStr));
  }

  /** Write a parsed document back to a daily file. */
  writeDaily(dateStr: string, doc: TaskDocument): void {
    this.writeFile(this.dailyFilePath(dateStr), serializeDocument(doc, this.timezone));
  }

  /** Write raw content to a daily file. */
  writeDailyRaw(dateStr: string, content: string): void {
    this.writeFile(this.dailyFilePath(dateStr), content);
  }

  /** Check if a daily file exists. */
  dailyExists(dateStr: string): boolean {
    return fs.existsSync(this.dailyFilePath(dateStr));
  }

  /** List all daily files sorted by date (newest first). */
  listDailyDates(): string[] {
    try {
      const files = fs.readdirSync(this.dailyDir)
        .filter((f) => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
        .map((f) => f.replace(".md", ""))
        .sort()
        .reverse();
      return files;
    } catch {
      return [];
    }
  }

  /** Get the latest daily file date. Returns null if no files. */
  getLatestDailyDate(): string | null {
    const dates = this.listDailyDates();
    return dates.length > 0 ? dates[0] : null;
  }

  /** Read recent N daily files. Returns { date, content, doc } sorted newest first. */
  readRecentDailies(n: number): Array<{ date: string; content: string; doc: TaskDocument }> {
    const dates = this.listDailyDates().slice(0, n);
    const result: Array<{ date: string; content: string; doc: TaskDocument }> = [];
    for (const date of dates) {
      const content = this.readDailyRaw(date);
      if (content) {
        result.push({ date, content, doc: parseDocument(content, this.timezone) });
      }
    }
    return result;
  }

  // --------------------------------------------------------------------------
  // Calendar file operations
  // --------------------------------------------------------------------------

  /** Read and parse the calendar file. */
  readCalendar(): TaskDocument {
    const content = this.readFile(this.calendarPath);
    if (!content) return { sections: [] };
    return parseDocument(content, this.timezone);
  }

  /** Write the calendar document. */
  writeCalendar(doc: TaskDocument): void {
    this.writeFile(this.calendarPath, serializeDocument(doc, this.timezone));
  }

  // --------------------------------------------------------------------------
  // Weekly file operations
  // --------------------------------------------------------------------------

  readWeekly(dateStr: string): string | null {
    return this.readFile(this.weeklyFilePath(dateStr));
  }

  writeWeekly(dateStr: string, content: string): void {
    this.writeFile(this.weeklyFilePath(dateStr), content);
  }

  weeklyExists(dateStr: string): boolean {
    return fs.existsSync(this.weeklyFilePath(dateStr));
  }

  /** Get the latest weekly report date. */
  getLatestWeeklyDate(): string | null {
    try {
      const files = fs.readdirSync(this.weeklyDir)
        .filter((f) => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
        .map((f) => f.replace(".md", ""))
        .sort()
        .reverse();
      return files.length > 0 ? files[0] : null;
    } catch {
      return null;
    }
  }

  /** Archive a weekly report (move to archived/). */
  archiveWeekly(dateStr: string): boolean {
    const src = this.weeklyFilePath(dateStr);
    const dst = path.join(this.archivedDir, `${dateStr}.md`);
    if (!fs.existsSync(src)) return false;
    fs.renameSync(src, dst);
    return true;
  }

  // --------------------------------------------------------------------------
  // Task CRUD (operates on a specific document)
  // --------------------------------------------------------------------------

  /**
   * Add a task to a document. Returns the new task item.
   */
  addTask(doc: TaskDocument, input: TaskAddInput, defaults: { reminderMinutes: number }): TaskItem {
    const section = ensureSection(doc, input.project, input.module, input.subModule);
    const id = this.generateId(doc);

    const task: TaskItem = {
      id,
      title: input.title,
      status: "todo",
      important: input.important ?? false,
      assignee: input.assignee,
      todayMarker: false,
      notes: input.notes ?? [],
      subItems: [],
    };

    // Schedule info
    if (input.schedule) {
      task.schedule = {
        startTime: input.schedule.startTime,
        durationMinutes: input.schedule.durationMinutes ?? 60,
        recurrence: input.schedule.recurrence ?? { kind: "none" },
        reminderMinutes: input.schedule.reminderMinutes ?? defaults.reminderMinutes,
      };
    }

    // Sub-items
    if (input.subItems) {
      for (const si of input.subItems) {
        if (si.kind === "note") {
          task.notes.push(si.text);
        } else {
          task.subItems.push({
            kind: "task",
            status: si.status ?? "todo",
            text: si.text,
            assignee: si.assignee,
          });
        }
      }
    }

    section.tasks.push(task);
    return task;
  }

  /**
   * Update a task in a document by ID.
   * Returns the updated task or null if not found.
   */
  updateTask(doc: TaskDocument, id: string, patch: TaskPatch): TaskItem | null {
    const task = findTaskById(doc, id);
    if (!task) return null;

    if (patch.title !== undefined) task.title = patch.title;
    if (patch.status !== undefined) task.status = patch.status;
    if (patch.important !== undefined) task.important = patch.important;
    if (patch.assignee !== undefined) task.assignee = patch.assignee;
    if (patch.todayMarker !== undefined) task.todayMarker = patch.todayMarker;

    if (patch.addNotes) {
      task.notes.push(...patch.addNotes);
    }

    if (patch.addSubItems) {
      task.subItems.push(...patch.addSubItems);
    }

    if (patch.schedule) {
      task.schedule = patch.schedule;
    }

    if (patch.cronJobId && task.schedule) {
      task.schedule.cronJobId = patch.cronJobId;
    }

    if (patch.progress) {
      // Replace existing progress sub-item or add new one
      const idx = task.subItems.findIndex((si) => si.kind === "progress");
      const progressItem: SubItem = {
        kind: "progress",
        current: patch.progress.current,
        total: patch.progress.total,
      };
      if (idx !== -1) {
        task.subItems[idx] = progressItem;
      } else {
        task.subItems.push(progressItem);
      }
    }

    return task;
  }

  /**
   * Remove a task from a document by ID.
   */
  removeTask(doc: TaskDocument, id: string): boolean {
    return removeTaskById(doc, id);
  }

  // --------------------------------------------------------------------------
  // Conflict detection (for calendar events)
  // --------------------------------------------------------------------------

  /**
   * Detect time conflicts between a proposed event and existing events.
   * Scans both the calendar file and the specified daily file.
   */
  detectConflicts(
    startTime: string,
    durationMinutes: number,
    excludeId?: string,
    dailyDate?: string,
  ): Array<{ task: TaskItem; overlapMinutes: number }> {
    const conflicts: Array<{ task: TaskItem; overlapMinutes: number }> = [];
    const newStart = new Date(startTime).getTime();
    const newEnd = newStart + durationMinutes * 60_000;

    const docs: TaskDocument[] = [this.readCalendar()];
    if (dailyDate) {
      const daily = this.readDaily(dailyDate);
      if (daily) docs.push(daily);
    }

    for (const doc of docs) {
      for (const task of allTasks(doc)) {
        if (task.id === excludeId) continue;
        if (!task.schedule) continue;
        if (task.status === "completed" || task.status === "cancelled") continue;

        const taskStart = new Date(task.schedule.startTime).getTime();
        const taskEnd = taskStart + task.schedule.durationMinutes * 60_000;
        const overlap = Math.max(0, Math.min(newEnd, taskEnd) - Math.max(newStart, taskStart));

        if (overlap > 0) {
          conflicts.push({ task, overlapMinutes: Math.ceil(overlap / 60_000) });
        }
      }
    }

    return conflicts;
  }

  // --------------------------------------------------------------------------
  // Summary helpers
  // --------------------------------------------------------------------------

  /** Count tasks by status in a document. */
  countByStatus(doc: TaskDocument): Record<string, number> {
    const tasks = allTasks(doc);
    const counts: Record<string, number> = { todo: 0, "stage-complete": 0, completed: 0, cancelled: 0 };
    for (const task of tasks) {
      counts[task.status] = (counts[task.status] || 0) + 1;
    }
    return counts;
  }
}
