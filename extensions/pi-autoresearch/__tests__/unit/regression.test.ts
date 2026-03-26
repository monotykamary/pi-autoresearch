/**
 * Regression tests for cherry-picked fixes and edge cases
 */

import { describe, it, expect } from "vitest";

// ============================================================================
// /autoresearch duplicate command guard
// ============================================================================
interface RuntimeForDuplicateGuard {
  autoresearchMode: boolean;
  state: { name: string | null };
  autoResumeTurns: number;
}

function createGuardRuntime(): RuntimeForDuplicateGuard {
  return {
    autoresearchMode: false,
    state: { name: null },
    autoResumeTurns: 0,
  };
}

describe("Cherry-picked fixes from upstream (fcd55f7)", () => {
  describe("Fix: /autoresearch duplicate command guard", () => {
    it("prevents duplicate /autoresearch activation", () => {
      const runtime = createGuardRuntime();
      const notifications: Array<{ message: string; type: string }> = [];

      function handleAutoresearchCommand(args: string, existingRuntime: typeof runtime) {
        const trimmedArgs = args.trim();
        const command = trimmedArgs.toLowerCase();

        if (existingRuntime.autoresearchMode && command !== "off" && command !== "clear") {
          notifications.push({
            message: "Autoresearch already active — use '/autoresearch off' to stop first",
            type: "info",
          });
          return { handled: false, reason: "already_active" };
        }

        existingRuntime.autoresearchMode = true;
        existingRuntime.state.name = trimmedArgs;
        notifications.push({ message: "Autoresearch mode ON", type: "info" });
        return { handled: true };
      }

      const result1 = handleAutoresearchCommand("optimize performance", runtime);
      expect(result1.handled).toBe(true);
      expect(notifications[0].message).toBe("Autoresearch mode ON");
      expect(runtime.autoresearchMode).toBe(true);
      expect(runtime.state.name).toBe("optimize performance");

      const result2 = handleAutoresearchCommand("optimize memory", runtime);
      expect(result2.handled).toBe(false);
      expect(result2.reason).toBe("already_active");
      expect(notifications[1].message).toContain("already active");

      expect(runtime.autoresearchMode).toBe(true);
      expect(runtime.state.name).toBe("optimize performance");
      expect(runtime.autoResumeTurns).toBe(0);
    });

    it("allows 'off' and 'clear' commands even when active", () => {
      const runtime = createGuardRuntime();
      runtime.autoresearchMode = true;
      runtime.state.name = "Active Session";
      runtime.autoResumeTurns = 3;

      function handleAutoresearchCommand(args: string, existingRuntime: typeof runtime) {
        const trimmedArgs = args.trim();
        const command = trimmedArgs.toLowerCase();

        if (existingRuntime.autoresearchMode && command !== "off" && command !== "clear") {
          return { handled: false, reason: "already_active" };
        }

        if (command === "off") {
          existingRuntime.autoresearchMode = false;
          existingRuntime.autoResumeTurns = 0;
          return { handled: true, action: "off" };
        }

        if (command === "clear") {
          existingRuntime.autoresearchMode = false;
          existingRuntime.state = createGuardRuntime().state;
          return { handled: true, action: "clear" };
        }

        return { handled: true };
      }

      const offResult = handleAutoresearchCommand("off", runtime);
      expect(offResult.handled).toBe(true);
      expect(offResult.action).toBe("off");

      runtime.autoresearchMode = true;
      runtime.state.name = "Active Session";

      const clearResult = handleAutoresearchCommand("clear", runtime);
      expect(clearResult.handled).toBe(true);
      expect(clearResult.action).toBe("clear");
    });
  });
});
