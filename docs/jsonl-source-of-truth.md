# JSONL as Source of Truth

## Overview

The `autoresearch.jsonl` file is the **sole source of truth** for experiment state. This means:

1. **Direct JSONL edits update the UI in real-time** — Edit the file and the dashboard updates automatically
2. **Cross-session persistence** — State survives context resets and session switches via the file alone
3. **Human-readable history** — The JSONL file is always inspectable and editable
4. **No session history dependency** — State is never reconstructed from pi session message history

## Real-Time UI Updates

The extension watches `autoresearch.jsonl` for changes using a file watcher. When the file changes:

1. State is reloaded from disk
2. Confidence scores and baselines are recalculated
3. The UI widget/dashboard updates automatically

This works for:

- Manual file edits
- `log_experiment` tool calls
- External processes writing to the file

## How It Works

### State Reconstruction

When a session starts/switches/forks, state is loaded **exclusively** from `autoresearch.jsonl`:

1. Parse config header (from `init_experiment`) → sets metric name, unit, direction, etc.
2. Parse each experiment line → appends to `state.results[]`
3. Register secondary metrics from results
4. Recalculate confidence scores and baselines from loaded data

If the JSONL doesn't exist or is corrupted, the state starts fresh (empty).

### JSONL Format

```jsonl
{"type":"config","name":"Optimize parsing speed","metricName":"total_µs","metricUnit":"µs","bestDirection":"lower","targetValue":null}
{"run":1,"commit":"abc1234","metric":15200,"metrics":{"compile_µs":4200},"status":"keep","description":"Baseline","timestamp":1712345678901,"segment":0,"confidence":null}
{"run":2,"commit":"def5678","metric":14100,"metrics":{"compile_µs":4100},"status":"keep","description":"Cached regex","timestamp":1712345689012,"segment":0,"confidence":2.1}
```

### Editing the JSONL

You can safely:

- Add/modify experiment lines (UI updates in real-time)
- Change descriptions or metrics
- Delete experiments (just remove the line)
- Edit the config header (carefully)

## Implementation Details

### Removed Session-Based Reconstruction

The following have been removed:

- `LogDetails.state` — no longer includes full experiment state
- `cloneExperimentState()` — function removed entirely
- Session history fallback in `createStateReconstructor()` — removed

### Added File Watcher

- `AutoresearchRuntime.jsonlWatcher` — tracks the active file watcher
- `startJsonlWatcher()` — starts watching the JSONL file for changes
- `stopJsonlWatcher()` — stops the watcher (cleanup)

### Key Functions

```typescript
// Reads state exclusively from JSONL
async function reconstructState(extCtx: ExtensionContext): Promise<void>;

// Watches JSONL for changes and updates UI
function startJsonlWatcher(extCtx, getRuntime, reconstructState, updateWidget): void;

// Called by:
// - session_switch / session_fork / session_tree (with worktree auto-detect)
// - /autoresearch command (after worktree setup)
```

### Files Modified

- `src/lifecycle/handlers.ts` — JSONL-only reconstruction, file watcher, removed session history fallback
- `src/tools/log-experiment.ts` — removed state from tool result details
- `src/tools/init-experiment.ts` — removed state from tool result details
- `src/state/index.ts` — removed `cloneExperimentState()`, added `jsonlWatcher` to runtime
- `src/types/index.ts` — removed `state` from `LogDetails`, added `jsonlWatcher` to runtime type
- `src/git/index.ts` — added `detectAutoresearchWorktree()` function
- `src/command.ts` — detect existing worktrees, start watcher, stop watcher on off/clear

### Watcher Cleanup

The watcher is stopped on:

- Session shutdown
- Session switch (before new session loads)
- `/autoresearch off`
- `/autoresearch clear`
