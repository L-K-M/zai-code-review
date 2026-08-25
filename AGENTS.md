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

### Comments
- Code should be self-documenting with clear function and variable names
- Add comments only when explaining **why** (not **what**)
- No inline comments for obvious code

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
