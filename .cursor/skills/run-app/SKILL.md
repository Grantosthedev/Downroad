---
name: run-app
description: Runs or reruns the Downroad Electron app. Use when the user says "run", "run app", "start app", "rerun", or "restart app". Kills any existing instance first, then starts the app.
---

# Run App

## When to Use

Apply this skill when the user says:
- "run"
- "run app"
- "start app"
- "rerun"
- "restart app"

## Instructions

**Option A — Use the run script:**
```bash
.cursor/skills/run-app/scripts/run.sh
```
Run from the project root. Run in the background.

**Option B — Manual steps:**
1. Kill existing instance: `pkill -f "Downroad" 2>/dev/null || true; sleep 1`
2. Start the app: `npm start` (from the project root)
3. Run in the **background** (long-running process).

Confirm to the user: "The app is running. The Downroad window should be open."
