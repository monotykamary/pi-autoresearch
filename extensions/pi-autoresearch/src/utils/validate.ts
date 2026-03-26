/**
 * Command validation utilities
 */

/**
 * Check if a command's primary purpose is running autoresearch.sh.
 *
 * Strategy: strip common harmless prefixes (env vars, env/time/nice wrappers)
 * then check that the core command is autoresearch.sh invoked via a known
 * pattern. Rejects chaining tricks like "evil.py; autoresearch.sh" because
 * we require autoresearch.sh to be the *first* real command.
 */
export function isAutoresearchShCommand(command: string): boolean {
  let cmd = command.trim();

  // Strip leading env variable assignments: FOO=bar BAZ="qux" ...
  cmd = cmd.replace(/^(?:\w+=\S*\s+)+/, "");

  // Strip known harmless command wrappers repeatedly
  let prev: string;
  do {
    prev = cmd;
    cmd = cmd.replace(/^(?:env|time|nice|nohup)(?:\s+-\S+(?:\s+\d+)?)*\s+/, "");
  } while (cmd !== prev);

  // Core command must be autoresearch.sh via known invocation
  return /^(?:(?:bash|sh|source)\s+(?:-\w+\s+)*)?(?:\.\/|\/[\w/.-]*\/)?autoresearch\.sh(?:\s|$)/.test(
    cmd
  );
}
