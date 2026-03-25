# Testing pi-autoresearch

This directory contains comprehensive tests for the pi-autoresearch extension.

## Test Structure

```
__tests__/
├── unit.test.ts              # 56 unit tests for pure functions
├── worktree.integration.test.ts  # 6 integration tests for git worktree operations
└── README.md                 # This file
```

## Running Tests

```bash
# Run all tests once
npm test

# Run tests in watch mode (for development)
npm run test:watch

# Run with coverage report
npm run test:coverage
```

## Test Categories

### Unit Tests (`unit.test.ts`)

Tests for pure, stateless functions extracted from the extension:

| Function | Description | Test Count |
|----------|-------------|------------|
| `parseMetricLines()` | Parses `METRIC name=value` lines from output | 10 |
| `computeConfidence()` | Calculates confidence score using MAD | 8 |
| `formatNum()` | Formats numbers with commas and units | 7 |
| `isAutoresearchShCommand()` | Validates autoresearch.sh commands | 11 |
| `isBetter()` | Compares metrics (lower/higher is better) | 4 |
| `sortedMedian()` | Calculates median robustly | 6 |
| `findBaselineMetric()` | Finds first metric in segment | 4 |
| Edge cases | Various edge case scenarios | 6 |

### Integration Tests (`worktree.integration.test.ts`)

Tests that create real git repositories and worktrees:

| Test | Description |
|------|-------------|
| creates worktree with branch | Verifies worktree + branch creation |
| lists worktrees correctly | Tests `git worktree list` output |
| worktree is isolated from main repo | Confirms isolation properties |
| removes worktree and cleans up | Tests cleanup procedures |
| detects existing worktree | Verifies worktree detection logic |
| autoresearch directory structure | Validates path structure |

## Key Test Scenarios

### Metric Parsing

Tests verify that the `METRIC name=value` format is correctly parsed:

```typescript
const output = `
  Some log output
  METRIC total_µs=15200
  METRIC compile_µs=4200
`;
// Expect: { total_µs: 15200, compile_µs: 4200 }
```

Edge cases covered:
- Prototype pollution protection (`__proto__`, `constructor`, `prototype`)
- Invalid values (Infinity, NaN, non-numeric)
- Duplicate names (last wins)
- Special characters (µ, dots in names)

### Confidence Calculation

Tests verify the Median Absolute Deviation (MAD) based confidence scoring:

```typescript
// Values: [100, 95, 80] — baseline 100, best kept 80
// MAD = median(|100-95|, |95-95|, |95-80|) = 10
// Delta = 20, Confidence = 20/10 = 2.0×
```

### Command Validation

The `isAutoresearchShCommand()` tests verify the security guard:

**Allowed:**
- `./autoresearch.sh`
- `bash autoresearch.sh`
- `DEBUG=1 ./autoresearch.sh`
- `time nice -n 10 bash -x ./autoresearch.sh`

**Rejected:**
- `evil.sh; ./autoresearch.sh` (chaining)
- `./other.sh autoresearch.sh` (wrong primary command)

### Worktree Integration

Tests create real git repos in `/tmp` or `.test-worktrees/` and verify:

1. Worktrees are created at `autoresearch/<session-id>/`
2. Each worktree has its own branch
3. Worktrees are isolated from main repo
4. Cleanup removes worktrees and branches

## Adding New Tests

### Unit Tests

Add to `unit.test.ts` following this pattern:

```typescript
describe("myFunction", () => {
  it("does what I expect", () => {
    // Copy function from extension
    function myFunction(x: number): number {
      return x * 2;
    }
    
    expect(myFunction(5)).toBe(10);
  });
});
```

### Integration Tests

Add to `worktree.integration.test.ts` following this pattern:

```typescript
it("my worktree scenario", () => {
  const sessionId = 'my-test';
  const worktreePath = path.join(repoDir, 'autoresearch', sessionId);
  
  // Create worktree
  execSync(`git worktree add ${worktreePath}`, { cwd: repoDir });
  
  // Test behavior
  expect(fs.existsSync(worktreePath)).toBe(true);
});
```

## Continuous Integration

Tests run on every PR and push to main. See `.github/workflows/test.yml`.

## Coverage

Current coverage targets:

| Metric | Target | Current |
|--------|--------|---------|
| Functions | 80% | ~75% |
| Lines | 70% | ~65% |

Note: Extension code that depends on the Pi Extension API is mocked or tested via integration tests.
