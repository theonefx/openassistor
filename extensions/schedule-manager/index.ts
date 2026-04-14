/**
 * OpenAssistor Schedule Manager Plugin — Unified Work & Calendar Management
 *
 * Combines calendar scheduling (meetings, reminders, conflict detection)
 * with work item tracking (task lifecycle, hierarchical organization, notes).
 *
 * CRUD Tools:
 *   - task_add:      Add a task or calendar event
 *   - task_list:     List/query tasks
 *   - task_update:   Update a task
 *   - task_remove:   Remove a task
 *
 * Daily Workflow Tools (aligned with summary project skills):
 *   - daily_plan:    Plan today's work (Mode C)
 *   - daily_update:  Quick progress update (Mode A)
 *   - daily_confirm: Batch confirm pending items (Mode B)
 *
 * Weekly Tool:
 *   - weekly_report: Generate or update weekly report
 *
 * Hooks:
 *   - before_agent_start: Inject today's schedule and pending items
 */

import { Type } from "@sinclair/typebox";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { scheduleConfigSchema } from "./config.js";
import { ScheduleStore } from "./store.js";
import {
  parseDocument,
  allTasks,
  findTaskById,
  getTaskPath,
} from "./format.js";
import type { TaskItem, TaskDocument, RecurrenceRule, Section } from "./types.js";
import {
  formatDateTime,
  formatTime,
  getTodayDateStr,
  getWeekRange,
  recurrenceToCronExpr,
  parseISO,
} from "./time-utils.js";

// ============================================================================
// Helpers
// ============================================================================

function normalizeRecurrence(input?: {
  kind: string; dayOfWeek?: number[]; dayOfMonth?: number; cronExpr?: string;
}): RecurrenceRule {
  if (!input) return { kind: "none" };
  switch (input.kind) {
    case "daily":    return { kind: "daily" };
    case "weekly":   return { kind: "weekly", dayOfWeek: input.dayOfWeek };
    case "monthly":  return { kind: "monthly", dayOfMonth: input.dayOfMonth };
    case "yearly":   return { kind: "yearly" };
    case "weekdays": return { kind: "weekdays" };
    case "custom":   return { kind: "custom", cronExpr: input.cronExpr ?? "* * * * *" };
    default:         return { kind: "none" };
  }
}

/** Format a task for tool output. */
function formatTaskItem(task: TaskItem, tz: string): string {
  const lines: string[] = [];
  const marker = task.todayMarker ? "⏰ " : "";
  const bold = task.important ? `**${task.title}**` : task.title;
  const assignee = task.assignee ? ` @${task.assignee}` : "";
  const statusMap = { todo: "[ ]", "stage-complete": "[->]", completed: "[x]", cancelled: "[~]" };
  lines.push(`- ${statusMap[task.status]} ${marker}${bold}${assignee} \`id:${task.id}\``);

  if (task.schedule) {
    const start = new Date(task.schedule.startTime);
    const end = new Date(start.getTime() + task.schedule.durationMinutes * 60_000);
    lines.push(`  ⏱ ${formatDateTime(start, tz)} - ${formatTime(end, tz)} (${task.schedule.durationMinutes}min)`);
  }

  for (const note of task.notes) {
    lines.push(`  > ${note}`);
  }

  for (const sub of task.subItems) {
    if (sub.kind === "task") {
      const a = sub.assignee ? ` @${sub.assignee}` : "";
      lines.push(`  - ${statusMap[sub.status]} ${sub.text}${a}`);
    } else if (sub.kind === "progress") {
      lines.push(`  - [->] 进度：${sub.current}/${sub.total}`);
    }
  }

  return lines.join("\n");
}

/** Compact format for context injection. */
function formatTaskCompact(task: TaskItem, tz: string): string {
  const marks: string[] = [];
  if (task.important) marks.push("[!]");
  if (task.assignee) marks.push(`@${task.assignee}`);
  const suffix = marks.length ? " " + marks.join(" ") : "";

  if (task.schedule) {
    const start = new Date(task.schedule.startTime);
    const end = new Date(start.getTime() + task.schedule.durationMinutes * 60_000);
    return `- ${formatTime(start, tz)}-${formatTime(end, tz)} ${task.title}${suffix}`;
  }

  const statusMap = { todo: "[ ]", "stage-complete": "[->]", completed: "[x]", cancelled: "[~]" };
  return `- ${statusMap[task.status]} ${task.title}${suffix}`;
}

/**
 * Build cron parameters for the agent to create a reminder.
 */
function buildCronReminderParams(
  task: TaskItem,
  timezone: string,
): Record<string, unknown> | null {
  if (!task.schedule || task.schedule.reminderMinutes <= 0) return null;
  const s = task.schedule;
  const startMs = new Date(s.startTime).getTime();
  const reminderMs = startMs - s.reminderMinutes * 60_000;

  if (s.recurrence.kind === "none") {
    if (reminderMs <= Date.now()) return null;
    return {
      action: "add",
      job: {
        name: `reminder: ${task.title}`,
        description: `Reminder for task [${task.id}] "${task.title}" starting at ${s.startTime}`,
        schedule: { kind: "at", at: new Date(reminderMs).toISOString() },
        sessionTarget: "main",
        payload: {
          kind: "systemEvent",
          text: `REMINDER: Task "${task.title}" starts in ${s.reminderMinutes} minutes.`,
        },
        deleteAfterRun: true,
      },
    };
  }

  const reminderDate = new Date(startMs - s.reminderMinutes * 60_000);
  const cronExpr = recurrenceToCronExpr(s.recurrence, reminderDate, timezone);
  if (!cronExpr) return null;

  return {
    action: "add",
    job: {
      name: `reminder: ${task.title}`,
      description: `Recurring reminder for task [${task.id}] "${task.title}"`,
      schedule: { kind: "cron", expr: cronExpr, tz: timezone },
      sessionTarget: "main",
      payload: {
        kind: "systemEvent",
        text: `REMINDER: Task "${task.title}" starts in ${s.reminderMinutes} minutes.`,
      },
    },
  };
}

// ============================================================================
// Tool Schemas
// ============================================================================

const RecurrenceSchema = Type.Optional(
  Type.Object({
    kind: Type.Union([
      Type.Literal("none"), Type.Literal("daily"), Type.Literal("weekly"),
      Type.Literal("monthly"), Type.Literal("yearly"), Type.Literal("weekdays"),
      Type.Literal("custom"),
    ]),
    dayOfWeek: Type.Optional(Type.Array(Type.Number({ minimum: 0, maximum: 6 }))),
    dayOfMonth: Type.Optional(Type.Number({ minimum: 1, maximum: 31 })),
    cronExpr: Type.Optional(Type.String()),
  }),
);

// ============================================================================
// Plugin
// ============================================================================

export default definePluginEntry({
  id: "schedule-manager",
  name: "Schedule Manager",
  description: "Unified work & calendar management with daily/weekly workflow support",
  configSchema: scheduleConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = scheduleConfigSchema.parse(api.pluginConfig);
    const store = new ScheduleStore(cfg.dataDir, cfg.timezone);

    api.logger.info(`schedule-manager: registered (dir: ${store.paths.base}, tz: ${cfg.timezone})`);

    // ========================================================================
    // Tool: task_add
    // ========================================================================
    api.registerTool({
      name: "task_add",
      label: "Add Task",
      ownerOnly: true,
      description: `Add a task or calendar event to the latest daily file (or calendar file for recurring events).

PARAMETERS:
- title (required): Task title
- project (required): Project name (# heading)
- module (optional): Module name (## heading)
- subModule (optional): Sub-module name (### heading)
- important (optional): Mark as priority (**bold**)
- assignee (optional): Person responsible (@name)
- notes (optional): Initial notes (string array, will appear as > blockquotes)
- schedule (optional): Calendar info for time-specific events:
  - startTime: ISO-8601 datetime
  - durationMinutes: Duration in minutes (default 60)
  - recurrence: { kind, dayOfWeek?, dayOfMonth?, cronExpr? }
  - reminderMinutes: Minutes before start for reminder (default ${cfg.defaultReminderMinutes})
- subItems (optional): Initial sub-tasks
- tags (optional): Tags array

If schedule is provided and has a reminder, the result includes "cronParams" — call the "cron" tool with those to activate.

TARGETS:
- Tasks with schedule.recurrence (recurring events) go to calendar.md
- All other tasks go to the latest daily file`,
      parameters: Type.Object({
        title: Type.String(),
        project: Type.String({ description: "# heading (project name)" }),
        module: Type.Optional(Type.String({ description: "## heading" })),
        subModule: Type.Optional(Type.String({ description: "### heading" })),
        important: Type.Optional(Type.Boolean()),
        assignee: Type.Optional(Type.String()),
        notes: Type.Optional(Type.Array(Type.String())),
        schedule: Type.Optional(Type.Object({
          startTime: Type.String({ description: "ISO-8601 datetime" }),
          durationMinutes: Type.Optional(Type.Number({ minimum: 1 })),
          recurrence: RecurrenceSchema,
          reminderMinutes: Type.Optional(Type.Number({ minimum: 0 })),
        })),
        subItems: Type.Optional(Type.Array(Type.Object({
          kind: Type.Union([Type.Literal("note"), Type.Literal("task")]),
          text: Type.String(),
          status: Type.Optional(Type.Union([
            Type.Literal("todo"), Type.Literal("stage-complete"), Type.Literal("completed"),
          ])),
          assignee: Type.Optional(Type.String()),
        }))),
        tags: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_toolCallId, params) {
        const p = params as any;

        // Validate schedule datetime if provided
        if (p.schedule?.startTime) {
          const parsed = parseISO(p.schedule.startTime);
          if (!parsed) {
            return {
              content: [{ type: "text", text: `Invalid datetime: "${p.schedule.startTime}". Use ISO-8601.` }],
              details: { error: "invalid_datetime" },
            };
          }
        }

        // Determine target file
        const isRecurring = p.schedule?.recurrence?.kind && p.schedule.recurrence.kind !== "none";
        let doc: TaskDocument;
        let targetLabel: string;

        if (isRecurring) {
          doc = store.readCalendar();
          targetLabel = "calendar.md";
        } else {
          const today = getTodayDateStr(cfg.timezone);
          doc = store.readDaily(today) ?? { sections: [] };
          targetLabel = `daily/${today}.md`;
        }

        // Normalize schedule
        const scheduleInput = p.schedule ? {
          startTime: p.schedule.startTime,
          durationMinutes: p.schedule.durationMinutes,
          recurrence: normalizeRecurrence(p.schedule.recurrence),
          reminderMinutes: p.schedule.reminderMinutes,
        } : undefined;

        // Conflict detection
        let conflictText = "";
        if (p.schedule) {
          const duration = p.schedule.durationMinutes ?? 60;
          const conflicts = store.detectConflicts(
            p.schedule.startTime, duration, undefined,
            getTodayDateStr(cfg.timezone),
          );
          if (conflicts.length > 0) {
            conflictText = "\n\nConflicts:\n" + conflicts.map((c) =>
              `  - "${c.task.title}" (overlap: ${c.overlapMinutes}min)`,
            ).join("\n");
          }
        }

        const task = store.addTask(doc, {
          title: p.title,
          project: p.project,
          module: p.module,
          subModule: p.subModule,
          important: p.important,
          assignee: p.assignee,
          notes: p.notes,
          schedule: scheduleInput,
          subItems: p.subItems,
          tags: p.tags,
        }, { reminderMinutes: cfg.defaultReminderMinutes });

        // Save
        if (isRecurring) {
          store.writeCalendar(doc);
        } else {
          const today = getTodayDateStr(cfg.timezone);
          store.writeDaily(today, doc);
        }

        const formatted = formatTaskItem(task, cfg.timezone);
        const cronParams = buildCronReminderParams(task, cfg.timezone);
        let reminderHint = "";
        if (cronParams) {
          reminderHint = `\n\nREMINDER SETUP: Call "cron" tool with the "cronParams" to activate. Then call task_update with { "id": "${task.id}", "cronJobId": "<returned-job-id>" }.`;
        }

        return {
          content: [{ type: "text", text: `Task added to ${targetLabel}:\n\n${formatted}${conflictText}${reminderHint}` }],
          details: { action: "created", id: task.id, target: targetLabel, cronParams },
        };
      },
    }, { name: "task_add" });

    // ========================================================================
    // Tool: task_list
    // ========================================================================
    api.registerTool({
      name: "task_list",
      label: "List Tasks",
      ownerOnly: true,
      description: `List tasks from daily files or calendar.

PARAMETERS:
- source: "today" (default), "latest", "calendar", or a date "YYYY-MM-DD"
- status: Filter by status (optional)
- includeAll: Include completed/cancelled (default false)
- reload: Force reload from disk`,
      parameters: Type.Object({
        source: Type.Optional(Type.String({ description: '"today", "latest", "calendar", or "YYYY-MM-DD"' })),
        status: Type.Optional(Type.Union([
          Type.Literal("todo"), Type.Literal("stage-complete"),
          Type.Literal("completed"), Type.Literal("cancelled"),
        ])),
        includeAll: Type.Optional(Type.Boolean()),
        reload: Type.Optional(Type.Boolean()),
      }),
      async execute(_toolCallId, params) {
        const p = params as any;
        const source = p.source ?? "today";

        let doc: TaskDocument;
        let label: string;

        if (source === "calendar") {
          doc = store.readCalendar();
          label = "calendar.md";
        } else if (source === "today") {
          const today = getTodayDateStr(cfg.timezone);
          doc = store.readDaily(today) ?? { sections: [] };
          label = `daily/${today}.md`;
        } else if (source === "latest") {
          const latest = store.getLatestDailyDate();
          if (!latest) {
            return {
              content: [{ type: "text", text: "No daily files found." }],
              details: { count: 0 },
            };
          }
          doc = store.readDaily(latest) ?? { sections: [] };
          label = `daily/${latest}.md`;
        } else {
          // Specific date
          doc = store.readDaily(source) ?? { sections: [] };
          label = `daily/${source}.md`;
        }

        let tasks = allTasks(doc);

        // Filter
        if (!p.includeAll) {
          tasks = tasks.filter((t) => t.status !== "completed" && t.status !== "cancelled");
        }
        if (p.status) {
          tasks = tasks.filter((t) => t.status === p.status);
        }

        if (tasks.length === 0) {
          return {
            content: [{ type: "text", text: `No tasks in ${label}.` }],
            details: { count: 0, source: label },
          };
        }

        const formatted = tasks.map((t) => formatTaskItem(t, cfg.timezone)).join("\n\n");
        return {
          content: [{ type: "text", text: `Tasks from ${label} (${tasks.length}):\n\n${formatted}` }],
          details: {
            count: tasks.length,
            source: label,
            items: tasks.map((t) => ({
              id: t.id, title: t.title, status: t.status,
              important: t.important, assignee: t.assignee,
              path: getTaskPath(doc, t.id).join(" > "),
            })),
          },
        };
      },
    }, { name: "task_list" });

    // ========================================================================
    // Tool: task_update
    // ========================================================================
    api.registerTool({
      name: "task_update",
      label: "Update Task",
      ownerOnly: true,
      description: `Update a task by ID. Searches latest daily file and calendar.

PARAMETERS:
- id (required): Task ID
- title, status, important, assignee, todayMarker: Direct field updates
- addNotes: Append new note lines (> blockquote)
- addSubItems: Append new sub-items
- schedule: Replace schedule info
- cronJobId: Link cron job ID
- progress: Update progress { current, total }

STATUS VALUES: "todo", "stage-complete", "completed", "cancelled"

When changing status to "completed"/"cancelled" and task has a cronJobId, also remove the cron job.`,
      parameters: Type.Object({
        id: Type.String(),
        title: Type.Optional(Type.String()),
        status: Type.Optional(Type.Union([
          Type.Literal("todo"), Type.Literal("stage-complete"),
          Type.Literal("completed"), Type.Literal("cancelled"),
        ])),
        important: Type.Optional(Type.Boolean()),
        assignee: Type.Optional(Type.String()),
        todayMarker: Type.Optional(Type.Boolean()),
        addNotes: Type.Optional(Type.Array(Type.String())),
        addSubItems: Type.Optional(Type.Array(Type.Object({
          kind: Type.Union([Type.Literal("note"), Type.Literal("task")]),
          text: Type.String(),
          status: Type.Optional(Type.Union([
            Type.Literal("todo"), Type.Literal("stage-complete"), Type.Literal("completed"),
          ])),
          assignee: Type.Optional(Type.String()),
        }))),
        schedule: Type.Optional(Type.Object({
          startTime: Type.String(),
          durationMinutes: Type.Number({ minimum: 1 }),
          recurrence: RecurrenceSchema,
          reminderMinutes: Type.Optional(Type.Number({ minimum: 0 })),
        })),
        cronJobId: Type.Optional(Type.String()),
        progress: Type.Optional(Type.Object({
          current: Type.Number(),
          total: Type.Number(),
        })),
      }),
      async execute(_toolCallId, params) {
        const p = params as any;
        const id = p.id as string;

        // Search in latest daily file first, then calendar
        type DocSource = { doc: TaskDocument; label: string; saveAs: "daily" | "calendar"; date?: string };
        const sources: DocSource[] = [];

        const latestDate = store.getLatestDailyDate();
        if (latestDate) {
          const doc = store.readDaily(latestDate);
          if (doc) sources.push({ doc, label: `daily/${latestDate}.md`, saveAs: "daily", date: latestDate });
        }
        const calDoc = store.readCalendar();
        sources.push({ doc: calDoc, label: "calendar.md", saveAs: "calendar" });

        let found: DocSource | null = null;
        for (const src of sources) {
          if (findTaskById(src.doc, id)) {
            found = src;
            break;
          }
        }

        if (!found) {
          return {
            content: [{ type: "text", text: `Task not found: "${id}". Use task_list to see available tasks.` }],
            details: { error: "not_found", id },
          };
        }

        const existing = findTaskById(found.doc, id)!;

        // Normalize sub-items for addSubItems
        const subItems = p.addSubItems?.map((si: any) => {
          if (si.kind === "note") return { kind: "note" as const, text: si.text };
          return { kind: "task" as const, status: si.status ?? "todo", text: si.text, assignee: si.assignee };
        });

        const updated = store.updateTask(found.doc, id, {
          title: p.title,
          status: p.status,
          important: p.important,
          assignee: p.assignee,
          todayMarker: p.todayMarker,
          addNotes: p.addNotes,
          addSubItems: subItems,
          schedule: p.schedule ? {
            startTime: p.schedule.startTime,
            durationMinutes: p.schedule.durationMinutes,
            recurrence: normalizeRecurrence(p.schedule.recurrence),
            reminderMinutes: p.schedule.reminderMinutes ?? 0,
          } : undefined,
          cronJobId: p.cronJobId,
          progress: p.progress,
        });

        if (!updated) {
          return {
            content: [{ type: "text", text: `Failed to update task "${id}".` }],
            details: { error: "update_failed" },
          };
        }

        // Save
        if (found.saveAs === "calendar") {
          store.writeCalendar(found.doc);
        } else {
          store.writeDaily(found.date!, found.doc);
        }

        // Hints
        let hints = "";
        if (p.status && p.status !== "todo" && p.status !== "stage-complete" && existing.schedule?.cronJobId) {
          hints += `\nNote: Task had cron reminder (${existing.schedule.cronJobId}). Remove it: { "action": "remove", "jobId": "${existing.schedule.cronJobId}" }`;
        }

        const formatted = formatTaskItem(updated, cfg.timezone);
        return {
          content: [{ type: "text", text: `Task updated in ${found.label}:\n\n${formatted}${hints}` }],
          details: {
            action: "updated",
            id: updated.id,
            source: found.label,
            item: { id: updated.id, title: updated.title, status: updated.status },
          },
        };
      },
    }, { name: "task_update" });

    // ========================================================================
    // Tool: task_remove
    // ========================================================================
    api.registerTool({
      name: "task_remove",
      label: "Remove Task",
      ownerOnly: true,
      description: `Remove a task permanently. Searches latest daily file and calendar.
To mark done instead of removing, use task_update with status="completed".`,
      parameters: Type.Object({
        id: Type.String({ description: "Task ID" }),
      }),
      async execute(_toolCallId, params) {
        const { id } = params as { id: string };

        // Search daily then calendar
        const latestDate = store.getLatestDailyDate();
        if (latestDate) {
          const doc = store.readDaily(latestDate);
          if (doc) {
            const task = findTaskById(doc, id);
            if (task) {
              const cronJobId = task.schedule?.cronJobId;
              store.removeTask(doc, id);
              store.writeDaily(latestDate, doc);
              let hint = "";
              if (cronJobId) hint = `\nNote: Remove linked cron job: { "action": "remove", "jobId": "${cronJobId}" }`;
              return {
                content: [{ type: "text", text: `Removed "${task.title}" (${id}) from daily/${latestDate}.md${hint}` }],
                details: { action: "removed", id, title: task.title, cronJobId },
              };
            }
          }
        }

        const calDoc = store.readCalendar();
        const calTask = findTaskById(calDoc, id);
        if (calTask) {
          const cronJobId = calTask.schedule?.cronJobId;
          store.removeTask(calDoc, id);
          store.writeCalendar(calDoc);
          let hint = "";
          if (cronJobId) hint = `\nNote: Remove linked cron job: { "action": "remove", "jobId": "${cronJobId}" }`;
          return {
            content: [{ type: "text", text: `Removed "${calTask.title}" (${id}) from calendar.md${hint}` }],
            details: { action: "removed", id, title: calTask.title, cronJobId },
          };
        }

        return {
          content: [{ type: "text", text: `Task not found: "${id}".` }],
          details: { error: "not_found", id },
        };
      },
    }, { name: "task_remove" });

    // ========================================================================
    // Tool: daily_plan
    // ========================================================================
    api.registerTool({
      name: "daily_plan",
      label: "Plan Today",
      ownerOnly: true,
      description: `Plan today's work (Mode C from daily-summary skill).

Reads recent daily files and the latest weekly report, then returns all the data
needed for the agent to create today's plan. The agent should then analyze,
carry forward unfinished tasks, and write the daily file.

RETURNS:
- today's date
- whether today's daily file already exists
- recent daily files content (last ${cfg.historyDays} workdays)
- latest weekly report content (if available)
- calendar events for today

AGENT WORKFLOW after calling this tool:
1. Analyze returned history to identify unfinished tasks
2. Identify tasks scheduled for today (⏰, 【date】 annotations)
3. Determine which items to carry forward
4. Ask user for any unclear items
5. Generate and write today's daily file using task_add or daily_write
6. Present final plan to user for confirmation`,
      parameters: Type.Object({
        forceNew: Type.Optional(Type.Boolean({ description: "Create plan even if today's file exists" })),
      }),
      async execute(_toolCallId, params) {
        const p = params as any;
        const today = getTodayDateStr(cfg.timezone);

        const exists = store.dailyExists(today);
        if (exists && !p.forceNew) {
          // Today's file already exists — suggest Mode A or B instead
          const content = store.readDailyRaw(today) || "";
          const doc = parseDocument(content, cfg.timezone);
          const counts = store.countByStatus(doc);
          return {
            content: [{
              type: "text",
              text: `Today's file (${today}) already exists. todo: ${counts.todo}, stage-complete: ${counts["stage-complete"]}, completed: ${counts.completed}.\n\nUse daily_update for quick updates or daily_confirm for batch confirmation. Pass forceNew=true to re-plan.`,
            }],
            details: { exists: true, date: today, counts },
          };
        }

        // Read history
        const recentDailies = store.readRecentDailies(cfg.historyDays);
        const historyContent = recentDailies.map((d) => {
          return `=== ${d.date} ===\n${d.content}`;
        }).join("\n\n");

        // Read latest weekly report
        const latestWeeklyDate = store.getLatestWeeklyDate();
        let weeklyContent = "";
        if (latestWeeklyDate) {
          weeklyContent = store.readWeekly(latestWeeklyDate) || "";
        }

        // Read calendar events
        const calDoc = store.readCalendar();
        const calTasks = allTasks(calDoc).filter((t) => t.status === "todo" || t.status === "stage-complete");
        const calendarSection = calTasks.length > 0
          ? calTasks.map((t) => formatTaskItem(t, cfg.timezone)).join("\n\n")
          : "No calendar events.";

        const output = [
          `# Daily Plan Data`,
          `Date: ${today}`,
          `File exists: ${exists}`,
          ``,
          `## Recent Daily Files (${recentDailies.length})`,
          historyContent || "No history.",
          ``,
          `## Latest Weekly Report${latestWeeklyDate ? ` (${latestWeeklyDate})` : ""}`,
          weeklyContent || "No weekly report found.",
          ``,
          `## Calendar Events (${calTasks.length})`,
          calendarSection,
        ].join("\n");

        return {
          content: [{ type: "text", text: output }],
          details: {
            date: today,
            exists,
            historyDates: recentDailies.map((d) => d.date),
            calendarEventCount: calTasks.length,
            weeklyDate: latestWeeklyDate,
          },
        };
      },
    }, { name: "daily_plan" });

    // ========================================================================
    // Tool: daily_update (Mode A — quick update)
    // ========================================================================
    api.registerTool({
      name: "daily_update",
      label: "Update Daily",
      ownerOnly: true,
      description: `Read and/or write the latest daily file for quick updates (Mode A).

Two modes:
1. READ: Call without "content" to get the current daily file content.
2. WRITE: Call with "content" to replace the daily file content.

For updating individual tasks by ID, use task_update instead.
This tool is for when the agent needs to rewrite/restructure the entire daily file.`,
      parameters: Type.Object({
        date: Type.Optional(Type.String({ description: "Target date YYYY-MM-DD (default: latest)" })),
        content: Type.Optional(Type.String({ description: "New file content to write (omit to read)" })),
      }),
      async execute(_toolCallId, params) {
        const p = params as any;

        let targetDate = p.date;
        if (!targetDate) {
          targetDate = store.getLatestDailyDate();
          if (!targetDate) {
            return {
              content: [{ type: "text", text: "No daily files found. Use daily_plan to create one." }],
              details: { error: "no_files" },
            };
          }
        }

        if (p.content !== undefined) {
          // WRITE mode
          store.writeDailyRaw(targetDate, p.content);
          const doc = parseDocument(p.content, cfg.timezone);
          const counts = store.countByStatus(doc);
          return {
            content: [{ type: "text", text: `Updated daily/${targetDate}.md (todo: ${counts.todo}, stage-complete: ${counts["stage-complete"]}, completed: ${counts.completed})` }],
            details: { action: "written", date: targetDate, counts },
          };
        }

        // READ mode
        const content = store.readDailyRaw(targetDate);
        if (!content) {
          return {
            content: [{ type: "text", text: `File daily/${targetDate}.md not found.` }],
            details: { error: "not_found", date: targetDate },
          };
        }

        const doc = parseDocument(content, cfg.timezone);
        const counts = store.countByStatus(doc);
        return {
          content: [{ type: "text", text: `daily/${targetDate}.md (todo: ${counts.todo}, stage-complete: ${counts["stage-complete"]}, completed: ${counts.completed}):\n\n${content}` }],
          details: { date: targetDate, counts, content },
        };
      },
    }, { name: "daily_update" });

    // ========================================================================
    // Tool: daily_confirm (Mode B — batch confirm)
    // ========================================================================
    api.registerTool({
      name: "daily_confirm",
      label: "Confirm Tasks",
      ownerOnly: true,
      description: `Batch confirm pending tasks in the latest daily file (Mode B from daily-summary skill).

Returns all pending tasks ([ ] status) organized by section hierarchy,
with numbered IDs for the user to batch-respond.

AGENT WORKFLOW:
1. Call this tool to get the pending task list
2. Present the numbered list to the user
3. Collect batch responses (e.g., "1.1.1 搞定了, 2.1.1 有进展 - xxx")
4. Use task_update for each item based on user response
5. Call daily_update to read the final state and present summary`,
      parameters: Type.Object({
        date: Type.Optional(Type.String({ description: "Target date (default: latest)" })),
      }),
      async execute(_toolCallId, params) {
        const p = params as any;
        let targetDate = p.date || store.getLatestDailyDate();
        if (!targetDate) {
          return {
            content: [{ type: "text", text: "No daily files found." }],
            details: { error: "no_files" },
          };
        }

        const doc = store.readDaily(targetDate);
        if (!doc) {
          return {
            content: [{ type: "text", text: `File daily/${targetDate}.md not found.` }],
            details: { error: "not_found" },
          };
        }

        // Build hierarchical numbered list of pending tasks
        const pendingList: string[] = [];
        const taskMap: Array<{ numbering: string; task: TaskItem }> = [];

        function hasAnything(section: Section): boolean {
          return section.tasks.some((t) => t.status === "todo") ||
            section.sections.some(hasAnything);
        }

        function processSections(sections: Section[], prefix: string, depth: number) {
          let idx = 0;
          for (const section of sections) {
            if (!hasAnything(section)) continue;
            idx++;
            const num = prefix ? `${prefix}.${idx}` : `${idx}`;
            const indent = "  ".repeat(depth);
            pendingList.push(`${indent}${num}. 【${section.title}】`);

            // Tasks directly under this section
            let taskIdx = 0;
            const pendingTasks = section.tasks.filter((t) => t.status === "todo");
            for (const task of pendingTasks) {
              taskIdx++;
              const taskNum = `${num}.${taskIdx}`;
              const taskIndent = "  ".repeat(depth + 1);
              const marker = task.important ? `**${task.title}**` : task.title;
              const assignee = task.assignee ? ` @${task.assignee}` : "";
              const schedule = task.schedule
                ? ` ⏱${formatTime(new Date(task.schedule.startTime), cfg.timezone)}`
                : "";
              pendingList.push(`${taskIndent}${taskNum} ${marker}${assignee}${schedule} \`${task.id}\``);
              taskMap.push({ numbering: taskNum, task });
            }

            // Recurse into child sections (handles all levels)
            processSections(section.sections, num, depth + 1);
          }
        }

        processSections(doc.sections, "", 0);

        if (taskMap.length === 0) {
          const counts = store.countByStatus(doc);
          return {
            content: [{
              type: "text",
              text: `All tasks confirmed! (completed: ${counts.completed}, stage-complete: ${counts["stage-complete"]})`,
            }],
            details: { date: targetDate, pendingCount: 0, counts },
          };
        }

        const header = `请确认以下工作项的进展（只需回复有更新的编号+状态/说明，未提及的视为无更新）：\n`;
        return {
          content: [{
            type: "text",
            text: header + pendingList.join("\n"),
          }],
          details: {
            date: targetDate,
            pendingCount: taskMap.length,
            tasks: taskMap.map((t) => ({
              numbering: t.numbering,
              id: t.task.id,
              title: t.task.title,
              assignee: t.task.assignee,
            })),
          },
        };
      },
    }, { name: "daily_confirm" });

    // ========================================================================
    // Tool: weekly_report
    // ========================================================================
    api.registerTool({
      name: "weekly_report",
      label: "Weekly Report",
      ownerOnly: true,
      description: `Read or write weekly reports.

Modes:
1. GENERATE: Call without "content" to read this week's daily files and the latest weekly report.
   The agent should then generate the weekly report and call back with "content".
2. WRITE: Call with "content" to save the weekly report.
3. UPDATE: Call with "content" and an existing weekly file to update it.

The tool returns daily files for the current week + the latest previous weekly report
as reference for format and style.`,
      parameters: Type.Object({
        action: Type.Optional(Type.Union([
          Type.Literal("read"), Type.Literal("write"),
        ], { description: '"read" to get data, "write" to save report' })),
        weekDate: Type.Optional(Type.String({ description: "Week's Friday date YYYY-MM-DD (default: this week)" })),
        content: Type.Optional(Type.String({ description: "Weekly report content to write" })),
      }),
      async execute(_toolCallId, params) {
        const p = params as any;
        const action = p.action ?? (p.content ? "write" : "read");

        // Calculate this week's Friday
        const { start: weekStart, end: weekEnd } = getWeekRange(cfg.timezone);
        // Friday is weekEnd - 1 day (weekEnd is Sunday)
        const friday = new Date(weekEnd + "T12:00:00Z");
        friday.setUTCDate(friday.getUTCDate() - 2); // Sunday - 2 = Friday
        const fridayStr = p.weekDate ?? friday.toISOString().slice(0, 10);

        if (action === "write") {
          if (!p.content) {
            return {
              content: [{ type: "text", text: "No content provided for writing." }],
              details: { error: "no_content" },
            };
          }
          store.writeWeekly(fridayStr, p.content);
          return {
            content: [{ type: "text", text: `Weekly report written to weekly/${fridayStr}.md` }],
            details: { action: "written", date: fridayStr },
          };
        }

        // READ mode — gather data for report generation
        // Get all daily files for the week
        const allDates = store.listDailyDates().reverse(); // oldest first
        const weekDailies = allDates.filter((d) => d >= weekStart && d <= weekEnd);
        const dailyContents = weekDailies.map((date) => {
          const content = store.readDailyRaw(date) || "";
          return `=== ${date} ===\n${content}`;
        }).join("\n\n");

        // Get latest previous weekly
        const latestWeekly = store.getLatestWeeklyDate();
        let prevWeeklyContent = "";
        if (latestWeekly && latestWeekly !== fridayStr) {
          prevWeeklyContent = store.readWeekly(latestWeekly) || "";
        }

        // Check if this week's report already exists
        const existing = store.readWeekly(fridayStr);

        const output = [
          `# Weekly Report Data`,
          `Week: ${weekStart} ~ ${weekEnd} (Friday: ${fridayStr})`,
          `Report exists: ${!!existing}`,
          ``,
          `## This Week's Daily Files (${weekDailies.length})`,
          dailyContents || "No daily files for this week.",
          ``,
          `## Previous Weekly Report${latestWeekly ? ` (${latestWeekly})` : ""}`,
          prevWeeklyContent || "No previous weekly report found.",
        ];

        if (existing) {
          output.push(``, `## Current Week Report (existing)`, existing);
        }

        return {
          content: [{ type: "text", text: output.join("\n") }],
          details: {
            weekDate: fridayStr,
            weekRange: { start: weekStart, end: weekEnd },
            dailyDates: weekDailies,
            previousWeeklyDate: latestWeekly,
            exists: !!existing,
          },
        };
      },
    }, { name: "weekly_report" });

    // ========================================================================
    // Hook: Inject today's context
    // ========================================================================
    if (cfg.injectTodaySchedule) {
      api.on("before_agent_start", async (_event) => {
        try {
          const today = getTodayDateStr(cfg.timezone);
          const now = new Date();

          // Read today's daily file
          const dailyDoc = store.readDaily(today);
          const dailyTasks = dailyDoc ? allTasks(dailyDoc).filter((t) => t.status === "todo" || t.status === "stage-complete") : [];

          // Read calendar events
          const calDoc = store.readCalendar();
          const calTasks = allTasks(calDoc).filter((t) => t.status === "todo" || t.status === "stage-complete");

          if (dailyTasks.length === 0 && calTasks.length === 0) return;

          const parts: string[] = [
            `<today-context>`,
            `Current time: ${formatDateTime(now, cfg.timezone)}`,
            `Daily file: ${store.paths.daily}/${today}.md`,
          ];

          if (calTasks.length > 0) {
            parts.push(`\nCalendar events (${calTasks.length}):`);
            parts.push(calTasks.map((t) => formatTaskCompact(t, cfg.timezone)).join("\n"));
          }

          if (dailyTasks.length > 0) {
            parts.push(`\nToday's tasks (${dailyTasks.length}):`);
            parts.push(dailyTasks.map((t) => formatTaskCompact(t, cfg.timezone)).join("\n"));
          }

          parts.push(`</today-context>`);

          const contextBlock = parts.join("\n");
          api.logger.info?.(`schedule-manager: injecting ${dailyTasks.length + calTasks.length} items into context`);
          return { prependContext: contextBlock };
        } catch (err) {
          api.logger.warn(`schedule-manager: context injection failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================
    api.registerService({
      id: "schedule-manager",
      start: () => {
        const latestDate = store.getLatestDailyDate();
        api.logger.info(`schedule-manager: started (latest daily: ${latestDate ?? "none"}, dir: ${store.paths.base})`);
      },
      stop: () => {
        api.logger.info("schedule-manager: stopped");
      },
    });
  },
});
