# AGENTS.md

This document contains essential information for agentic coding assistants working in this repository.

## Build Commands

### Build
```bash
npm run build
```
Bundles `src/index.js` into `dist/index.js` using `@vercel/ncc`. The `dist/` directory **must be committed** as GitHub Actions executes it directly.

### Development setup
```bash
npm install
```
Install dependencies. Requires Node.js 20+.

### Testing
```bash
npm test                  # Run all tests
npm run test:watch       # Run tests in watch mode
npm run lint             # Run ESLint
npm run ci               # Run lint, tests, and build
```

## Code Style Guidelines

### Language & Runtime
- **Language:** JavaScript (CommonJS modules)
- **Runtime:** Node.js 20+
- **Module system:** `require()` and `module.exports` (no ESM)

### Imports
- Use CommonJS `require()` for all imports
- Group external dependencies at the top, then internal modules
- Separate groups with blank lines

```javascript
const core = require('@actions/core');
const github = require('@actions/github');
const https = require('https');
```

### Naming Conventions
- **Constants:** `UPPER_SNAKE_CASE` at module level
  ```javascript
  const ZAI_API_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';
  const MAX_RESPONSE_SIZE = 1024 * 1024;
  ```
- **Functions:** `camelCase`
  ```javascript
  async function getChangedFiles(octokit, owner, repo, pullNumber) {}
  ```
- **Variables:** `camelCase`
  ```javascript
  const { data } = await octokit.rest.pulls.listFiles({});
  ```
- **Parameters:** `camelCase`, descriptive names

### Formatting
- **Indentation:** 2 spaces (no tabs)
- **Line length:** Prefer under 100 characters, but be flexible
- **Semicolons:** Required
- **Quotes:** Single quotes for strings, double quotes in JSON
- **Spacing:** Spaces around operators and after commas

```javascript
const files = [];
let page = 1;
while (true) {
  const { data } = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
    page,
  });
}
```

### Functions
- Use `async/await` for asynchronous operations
- Prefer `async function` declarations over arrow functions for top-level functions
- Use arrow functions for callbacks and short inline functions

```javascript
async function run() {
  const apiKey = core.getInput('ZAI_API_KEY', { required: true });
  core.setSecret(apiKey);
  // ...
}

req.on('error', reject);
req.setTimeout(REQUEST_TIMEOUT_MS, () => {
  req.destroy(new Error('Z.ai API request timed out.'));
});
```

### Error Handling
- Always use `Error` objects with descriptive messages
- Include context in error messages (API endpoints, status codes, etc.)
- Use `core.setFailed()` for action-level errors in the GitHub Actions context

```javascript
reject(new Error(`${ERR_PREFIX}Invalid JSON response.`));
reject(new Error(`${ERR_PREFIX}HTTP ${res.statusCode}.`));
core.setFailed('This action only runs on pull_request events.');
```

**Important:** Never include API response data in error messages to prevent sensitive information leakage.

### Secrets & Security
- **Immediately** mark secrets with `core.setSecret()` to prevent them from appearing in logs
- Never log API keys, tokens, or sensitive data

```javascript
const apiKey = core.getInput('ZAI_API_KEY', { required: true });
core.setSecret(apiKey);
```

### GitHub Actions Conventions
- Use `@actions/core` for input/output, logging, and secrets
- Use `@actions/github` for Octokit and context access
- Log informational messages with `core.info()`
- Entry point is `dist/index.js` (defined in `action.yml`)

### Destructuring & Modern Syntax
- Use object destructuring for clarity
- Use template literals for string interpolation
- Use optional chaining (`?.`) when accessing potentially undefined properties

```javascript
const { context } = github;
const { owner, repo } = context.repo;
const pullNumber = context.payload.pull_request?.number;
const content = parsed.choices?.[0]?.message?.content;
```

### Constants & Magic Numbers
- Define constants for magic numbers and repeated strings
- Group related constants at the top of the file

```javascript
const COMMENT_MARKER = '<!-- zai-code-review -->';
const MAX_RESPONSE_SIZE = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 300_000;
```

## Project Structure

```
src/index.js      # Action source code (edit this)
dist/index.js     # Compiled bundle (committed, run by GitHub Actions)
action.yml        # Action metadata and input definitions
package.json      # Dependencies and build script
```

**Important:** The `dist/` directory is committed to the repository because GitHub Actions does **not** run `npm install` or build steps. Always run `npm run build` after editing `src/index.js` and commit both changes.

## API Integration Patterns

When working with external APIs:
- Use native `https` module for requests (no external HTTP libraries to minimize bundle size)
- Set timeouts to prevent hanging requests
- Implement response size limits to prevent memory issues
- Handle JSON parsing errors gracefully
- Never include API response data in error messages
- Validate input parameters before sending requests
- Implement retry logic with exponential backoff for transient failures

See `callZaiApiWithRetry()` in `src/index.js` for a reference implementation.

## Pagination

When working with paginated GitHub APIs, fetch all pages before processing:

```javascript
async function getChangedFiles(octokit, owner, repo, pullNumber) {
  const files = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });
    files.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return files;
}
```

## PR Comment Management

Use comment markers to allow updating existing comments instead of creating duplicates:

```javascript
const COMMENT_MARKER = '<!-- zai-code-review -->';
const body = `## ${reviewerName}\n\n${review}\n\n${COMMENT_MARKER}`;

// Find and update existing comment, or create new one
const existing = comments.find(c => c.body.includes(COMMENT_MARKER));
if (existing) {
  await octokit.rest.issues.updateComment({ /* ... */ });
} else {
  await octokit.rest.issues.createComment({ /* ... */ });
}
```

## Workflow Inputs

All action inputs are defined in `action.yml`. When adding new inputs:
1. Add the input to `action.yml` with description, required status, and default value
2. Retrieve it in code using `core.getInput('INPUT_NAME', { required: true/false })`
3. Mark sensitive inputs with `core.setSecret()` immediately after retrieval

## Review modes

`ZAI_REVIEW_MODE` controls review scope. The default remains `full`; repositories
must opt into the other modes deliberately.

- `full`: review the complete base-to-head PR diff on every run. Use for the
  first deep review, high-risk changes, force-push recovery, or a deliberate
  pre-merge audit.
- `incremental`: after the first completed review, review only changes since
  the last successfully reviewed head. Use for low-risk or very large PRs when
  shortest feedback latency matters more than repeated inspection of old code.
- `hybrid`: after the first completed review, review the incremental delta plus
  a rotating sample of older PR changes. This is the recommended iterative
  implementation mode. `ZAI_UNCHANGED_AUDIT_CHARS` controls the sample budget.

Implementers can override the configured mode for a PR by applying exactly one
of `zai-review:full`, `zai-review:hybrid`, or `zai-review:incremental` before the
next review-triggering push. Conflicting labels choose the widest/safest scope.
A missing state marker, failed comparison, non-ancestor/force-pushed history,
or incomplete prior review must fall back to `full`. Review state may advance
only after every selected chunk succeeds.

<!-- shared-rules:start -->

## Working practices

- Follow explicit task instructions over the default workflow below.
- Before editing, inspect the branch and working tree, fetch remote updates,
  and fast-forward where safe. Never overwrite existing work to update.
- Resolve ambiguity before making consequential changes. State low-risk
  assumptions; ask when scope, safety, or expected behavior is unclear.
- Keep changes focused. Do not modify unrelated code, formatting, or comments.
- Prefer surgical edits over whole-file rewrites when the result is equivalent.
- Stage only intended files. Inspect the diff before committing.

## Communication

- Be concise, factual, and direct. Preserve necessary context and uncertainty.
- Avoid praise, motivational filler, emojis, and em dashes in new prose.
- Address the reader directly in user-facing copy.
- Report what was verified and what remains unverified. Never imply that an
  unavailable check passed.

## Code design

- Prefer early returns and shallow nesting. Separate logical blocks with
  blank lines.
- Use descriptive constants or enums for meaningful or repeated values.
  Use existing standard definitions for protocol/specification constants.
  Keep obvious, one-off values inline.
- Use enums for behavioral modes that would otherwise require ambiguous
  boolean arguments.
- Default members to private. Widen visibility only for required consumers,
  and review the change as an API design decision.
- Follow the repository's declared dependency boundaries. UI and controllers
  must use application services rather than directly accessing databases,
  subprocesses, sockets, or other low-level mechanisms.
- Encapsulate low-level mechanics behind domain-oriented interfaces.
- Reuse genuinely shared logic. Avoid speculative abstractions and layers
  that only forward calls.
- Prefer pure functions for business rules and immutable data where practical.
  Isolate side effects; document non-obvious state ownership or synchronization.
- Explain non-obvious intent, constraints, and tradeoffs in comments.
  Do not narrate obvious code. Add examples or diagrams when they clarify it.

## Validation and errors

- Validate untrusted input at entry points. Where practical, represent valid
  states in types and enforce persistent invariants in database schemas.
- Represent absence and failure explicitly.
- Use assertions for internal programming invariants, not external-input
  validation or required runtime error handling.
- Prefer explicit, actionable errors over silent failure or undocumented
  fallback. Document intentional recovery behavior.
- Never report a skipped or failed operation as successful.

## Bug fixes

1. Identify the root cause and define an observable success criterion.
2. Add a regression test and observe the relevant failure before fixing it.
3. Implement the fix and observe the test passing.
4. Check surrounding behavior for regressions and architectural consistency.

If an automated regression test is impractical, document the reproduction
and verification procedure. State any inability to reproduce the failure.

## Verification

- Run relevant tests and lint after changes.
- Choose coverage by affected behavior and risk, not patch size.
- Use integration or end-to-end tests for critical workflows and boundaries;
  test isolated business rules at the lowest effective level.
- Run broader suites for cross-cutting or high-risk changes, and the full
  required release checks before releasing.
- Validate the requested command, options, platform, and configuration.
  Unrelated green CI is not proof that the reported problem is fixed.
- Recheck after the final edit. Distinguish local checks from CI results.

## Commit messages

- Use a capitalized, imperative subject without a final period.
- Target 50 characters; never exceed 72.
- Separate the subject and body with one blank line.
- Wrap body text at 72 characters.
- Explain what changed and why. Leave implementation mechanics to the code.

## Implementation and review

Unless explicitly instructed otherwise:

1. Work on a focused branch and open a PR against main.
2. Inspect CI results and completed review feedback for the latest commit.
   A successful reviewer job does not mean the review found no problems.
3. Address important findings or explain why they do not apply. Handle minor
   findings according to the stopping rules below.
4. Evaluate each fix in the surrounding project, add regression coverage,
   and rerun affected checks before pushing.
5. Repeat until a stopping criterion is met.
6. Merge without asking again once the stopping criterion is met, required
   checks pass on the latest commit, and no unresolved blockers or required
   human review requests remain.

### Automated review stopping rules

Judge findings by verified impact, not the reviewer's severity label.
Important findings concern correctness, security, data loss, broken builds,
or materially degraded behavior/performance.

Track completed review rounds and consecutive rounds without important
findings. Reruns of the same revision and integration failures do not count.

- No applicable actionable feedback: finish immediately.
- First minor-only round: optionally fix worthwhile, low-risk findings.
  Do not manufacture another push merely to obtain another review.
- Two consecutive rounds without important findings: stop responding to
  automated nitpicks, even if actionable minor suggestions remain.
  Defer worthwhile leftovers rather than continuing the cycle.
- A confirmed important finding resets the minor-only streak. Address it
  and verify the fix before continuing.

After ten completed rounds, enter stabilization:

- Stop optional cleanup, refactoring, and nitpick fixes.
- One completed review without confirmed important findings is sufficient
  to finish, even if minor suggestions remain.
- Continue only for confirmed important defects. If resolving them stalls,
  report the blockers rather than continuing indefinitely.

These limits end optional automated-feedback work. They do not waive
confirmed blockers, unresolved human review requests, or required checks.

### Reviewer integration failures

After two consecutive reviewer-integration failures, stop and report the
review gap. Do not treat failures as approval. An explicit user instruction
may waive review; report that waiver rather than claiming review passed.

## Completion checklist

- The requested behavior is implemented without unrelated changes.
- Relevant checks pass for the latest code.
- Important review findings are addressed or rejected with reasons.
- Deferred suggestions, remaining risks, and validation gaps are disclosed.
- The final response accurately states whether work is committed, pushed,
  and merged.

<!-- shared-rules:end -->
