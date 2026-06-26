---
name: headless-flow
description: Queue seeder for the conductor architecture. Calls plan_tasks to enqueue work, then exits. The conductor (Node.js loop in mcp_server.js) owns all worker dispatch. Updated 2026-06-17.
triggers:
  - run headless
  - headless mode
  - autonomous run
---

# Headless Flow

The conductor (a Node.js while loop in `server/mcp/conductor.js`) owns all Task
dispatch and execution. This skill's only job is to seed the queue via `plan_tasks`
and exit. Do NOT claim tasks. Do NOT dispatch tasks. Do NOT run worker skills.

Forbidden: `claim_task`, `pipeline.rescore`, direct sqlite writes, direct
`next_source` / `mark_source`, ad-hoc harvester traversal, user questions.

## Step 0 -- Resolve objective

Read `objective` from the `init-wizard.md` handoff (or from the startup prompt:
scan for `objective=marketplace|outreach|hybrid`). Valid values: `marketplace`,
`outreach`, `hybrid`. If none was supplied, default to `marketplace` (the headless
default).

If `objective` is `outreach` or `hybrid`, the Gmail MCP MUST already be registered
(init-wizard verifies this; arriving here without `gmail__gmail_send` registered
means STOP with `OUTREACH_REQUIRES_GMAIL`).

## Step 1 -- Seed the queue

```
precrime__pipeline({ action: "plan_tasks", mode: "headless", objective: "<objective>" })
```

Record `counts`, `session_id`, and `objective` from the response.

The Planner owns workflow strategy. If `workflowStrategy.strategy` is
`consume_factlets`, the Planner will prioritize APPLY_FACTLET / JUDGE_AFFECTED
Tasks -- you do not need to do anything differently.

## Step 2 -- Exit

The conductor is already running. It will poll the Task table, claim Tasks, spawn
one-shot workers (Goose or Claude), and mark Tasks done or failed -- all without
your involvement. Worker context stays isolated in each spawned process.

Your context must stay clean. Exit now. Do not claim a Task. Do not check status.
Do not poll. The conductor does not need you.

## Step 3 -- Report (separate invocation, after conductor finishes)

When called again after the conductor has drained the queue (e.g., via a cron job
or manual trigger), report results:

```
precrime__pipeline({ action: "report_session", session_id: "<session_id from Step 1>" })
```

Append one block to `logs/ROUNDUP.md`:

```
== Headless run completed <ISO timestamp> ==
Objective: <objective>
Session: <session_id>
Tasks completed / failed: (from report_session response)
Exit reason: conductor_drained
```

Then exit. Do not call `plan_tasks` again.
