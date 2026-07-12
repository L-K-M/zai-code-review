# Z.ai Code Review

AI-powered GitHub Pull Request code review using Z.ai models. Automatic PR comments, bug detection, improvement suggestions, and security checks via GitHub Actions.

**Latest version: v0.0.9**

## ✨ What's New in v0.0.9

- 🧵 **Inline threading fixed** - The production entry point no longer breaks thread matching through a circular dependency
- 📦 **Bounded large-PR reviews** - Exclusion patterns, diff budgets, and per-file truncation prevent oversized API requests and disclose omitted coverage
- 🔁 **Safer API retries** - Permanent client errors fail immediately while transient failures honor bounded retry delays
- 🔒 **Dependency security update** - Runtime dependencies now pass `npm audit`

<details>
<summary>Previous: v0.0.8</summary>

- ⚠️ **Incomplete reviews disclosed** - Final comments show a caution when one or more chunks fail
- 📊 **Clear chunk merge logging** - Logs distinguish successful and failed chunks
- 🧪 **Partial-failure regression coverage** - Tests cover incomplete merged reviews
- 🔎 **Richer retry diagnostics** - Logs include chunk context, prompt size, and elapsed time

</details>

<details>
<summary>Previous: v0.0.7</summary>

- 🧩 **Fixed real-world combined chunk parsing** - Final review grouping now handles plain severity banners, contextual heading-style findings, and bold finding titles from multi-chunk output
- 🧹 **Stops narrative leakage between findings** - Chunk markers and review filler text no longer bleed into the previous finding body
- 🛡️ **Hardened review prompt contract** - The reviewer is now explicitly told to avoid conversational intros, standalone severity banners, and chunk/part headings in chunk responses
- ✅ **Added production-shape regression coverage** - Tests now cover the noisy combined syntax seen in v0.0.6 outputs, not just idealized bracketed findings

</details>

<details>
<summary>Previous: v0.0.6</summary>

- 📍 **Accurate security line numbers** - SecurityCheck now parses diff hunk headers (`@@`) for correct file line numbers
- 📦 **Oversized file handling** - Files exceeding 50KB are flagged and isolated into their own chunk with warnings
- 📄 **Pagination for resolved comments** - Now handles PRs with 100+ resolved review comments
- 🔒 **Input validation** - Thread similarity threshold validated to 0-1 range; head SHA checked early
- 🛡️ **Failure recovery** - All chunks failing now aborts gracefully instead of posting empty review

</details>

<details>
<summary>Previous: v0.0.5</summary>

- 📊 **Fixed multi-chunk severity grouping** - Chunked reviews now stay in Critical, Major, Minor, and Info instead of collapsing into Info after the first chunk
- 💬 **Fixed inline comment threading** - Separate findings no longer pile into the first matching inline thread
- 🧵 **Safer thread reuse** - Replies are now reserved for actual follow-up on the same finding within an existing thread

</details>

## 🎯 Features

- 🐛 **Bug detection** - Identifies logic errors, bugs, and potential runtime issues
- ✨ **Improvement suggestions** - Actionable recommendations for code quality
- 🤖 **AI-driven review** - Leverages Z.ai models for contextual code review
- ⚡ **GitHub Actions native** - Runs automatically on PR events
- 💬 **Inline code suggestions** - Posts actionable diff suggestions as GitHub review comments
- 🔒 **Static security checks** - Scans for hardcoded secrets, eval, dangerous functions, disabled lint
- 📄 **Repository preferences** - Can consume an existing `.zai-feedback.json` preference file when the repository is checked out

<details>
<summary>📦 Advanced Features</summary>

- 📦 **Large PR support** - Automatic chunking for PRs that exceed token limits
- 🚫 **Comment deduplication** - Prevents duplicate suggestions across chunks and reviews
- 🧵 **Threaded comments** - Replies to existing threads instead of creating duplicates
- ⏭️ **Resolved comment filtering** - Skips suggestions on already-resolved discussions
- 📊 **Severity grouping** - Groups findings by severity (Critical, Major, Minor, Info) in collapsible sections
- 🔍 **Outside-diff handling** - Separates and groups comments outside the diff range

</details>

## 📋 Prerequisites

- ✅ A **Z.ai account** with API access - [Get your API key](https://platform.z.ai)
- ✅ A **GitHub repository** with GitHub Actions enabled

## 🚀 Quickstart

### Step 1: Create the workflow file

Create `.github/workflows/code-review.yml`:

```yaml
name: AI Code Review with Z.ai

on:
  pull_request:
    types: [opened, synchronize]

permissions:
  issues: write
  pull-requests: write

jobs:
  review:
    name: Review
    runs-on: ubuntu-latest
    steps:
      - name: Code Review
        uses: L-K-M/zai-code-review@v0.0.9
        with:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
          ZAI_MODEL: ${{ vars.ZAI_MODEL || 'glm-4.7' }}
          ZAI_REVIEWER_NAME: ${{ vars.ZAI_REVIEWER_NAME || 'Z.ai Code Review' }}
          ZAI_SYSTEM_PROMPT: ${{ vars.ZAI_SYSTEM_PROMPT || '' }}
          EXCLUDE_PATTERNS: ${{ vars.EXCLUDE_PATTERNS || '*.lock,package-lock.json,yarn.lock,pnpm-lock.yaml' }}
          MAX_DIFF_CHARS: ${{ vars.MAX_DIFF_CHARS || '0' }}
          ZAI_THREAD_SIMILARITY_THRESHOLD: ${{ vars.ZAI_THREAD_SIMILARITY_THRESHOLD || '0.6' }}
```

### Step 2: Add your Z.ai API key

1. Go to your repository → **Settings** → **Secrets and variables → Actions**
2. Click **New repository secret**
3. Add: **Name:** `ZAI_API_KEY`, **Value:** Your key from [platform.z.ai](https://platform.z.ai)

### Step 3: Push and test!

Commit the workflow and create a PR. The review appears automatically as a comment.

## 📖 What You'll See

### Review Comment Format

Findings are grouped by severity in collapsible sections:

```
## Z.ai Code Review

**Actionable suggestions identified: 3**

<details>
<summary>🔴 Critical/BLOCKER findings (1)</summary><blockquote>

**SQL Injection in query builder**

**Problem:** User input is directly concatenated into SQL query.

**Impact:** Allows attackers to execute arbitrary SQL commands.

**Suggested fix:**
- const query = `SELECT * FROM users WHERE id = ${userId}`;
+ const query = 'SELECT * FROM users WHERE id = ?';
+ db.query(query, [userId]);

</blockquote></details>

<details>
<summary>🟠 Major comments (2)</summary><blockquote>
...
</blockquote></details>
```

### Inline Suggestions

Actionable code replacements are posted as GitHub review comments:

```diff
- console.log(user);
+ console.log({ user });
```

Reviewers can accept/reject suggestions directly in the GitHub UI.

## 🔒 Security Checks

Built-in static security checks on all diffs:

| Pattern | Severity | Description |
|---|---|---|
| Hardcoded API keys/secrets | Critical | Detects `api_key = "..."` or `secret = "..."` patterns |
| `eval()` usage | Critical | Flags dangerous dynamic code execution |
| Hardcoded passwords | Critical | Detects weak or hardcoded passwords |
| Dangerous functions | Major | Detects exec(), new Function(), child_process require |
| Disabled lint/security | Minor | Flags eslint-disable, tslint:disable |

Security findings now report **accurate file line numbers** using diff hunk headers.

## 🧠 Repository Preferences

If the workflow checks out the repository, the action can consume an existing
`.zai-feedback.json` file to filter known unwanted suggestions. The action does not infer
acceptance from GitHub review events or commit this file automatically.

## 🏗️ How It Works

<details>
<summary>Architecture & Processing Pipeline</summary>

For small to medium PRs, all changes are sent in a single API request. Larger PRs are automatically split into chunks (50K characters each).

**Processing Pipeline:**

1. **Fetch Changed Files** - Retrieves all files in the PR with pagination
2. **Security Check** - Runs static analysis for hardcoded secrets, eval, dangerous functions
3. **AI Review** - Sends diff to Z.ai API with conversational feedback prompt
4. **Post-Processing** - Parses findings, groups by severity, formats with collapsible sections
5. **Inline Suggestions** - Extracts and posts actionable code suggestions as GitHub review comments
6. **Threading** - Checks existing threads and replies instead of creating duplicates
7. **Repository Preferences** - Applies an existing `.zai-feedback.json` file when available
8. **Deduplication** - Filters resolved suggestions and prevents duplicate comments

</details>

## ⚙️ Configuration

<details>
<summary>🔧 Customization Options</summary>

#### Using Repository Variables (Recommended)

1. Go to repository **Settings** → **Secrets and variables → Actions**
2. Click **Variables** → **New repository variable**
3. Add any of:

| Variable | Example | Description |
|----------|---------|-------------|
| `ZAI_MODEL` | `glm-4.7` | AI model to use |
| `ZAI_REVIEWER_NAME` | `Security Bot` | Name in comment header |
| `ZAI_THREAD_SIMILARITY_THRESHOLD` | `0.7` | Thread matching strictness (higher = stricter) |
| `ZAI_SYSTEM_PROMPT` | `You are an expert...` | Custom system prompt |
| `EXCLUDE_PATTERNS` | `*.lock,dist/**` | Comma-separated file patterns to omit |
| `MAX_DIFF_CHARS` | `200000` | Optional total diff budget; `0` is unlimited |

**Benefits:** Customize without editing workflow, change settings without committing, same workflow across environments.

#### Organization-Level Variables

For multi-repository setups, configure at the organization level to apply settings across all repositories.

</details>

<details>
<summary>🔬 Advanced Configuration</summary>

#### Thread Similarity Threshold

- **Range:** `0.0` to `1.0`
- **Default:** `0.6`
- **Higher values** (e.g., `0.8`): More strict, creates new threads more often
- **Lower values** (e.g., `0.4`): More permissive, replies to existing threads more often

#### Repository Preferences

- Add `actions/checkout` before this action if you maintain `.zai-feedback.json` or `.zai-review.yaml`
- `ZAI_COMMIT_FEEDBACK` is retained as a deprecated compatibility input and has no effect

#### System Prompt

The default prompt instructs the AI to:
- Review code changes with clear, actionable feedback
- Focus on bugs, logic errors, security issues, and meaningful improvements
- Skip trivial style comments
- Use severity markers: `[BLOCKER]`, `[CRITICAL]`, `[Major]`, `[Minor]`, `[Info]`
- Emit inline suggestions: `[[suggestion:path:file:line:...]]`

```yaml
ZAI_SYSTEM_PROMPT: |
  You are an expert code reviewer. Focus on security and performance.
```

</details>

## 🚀 Advanced Usage

<details>
<summary>Chunking for Large PRs</summary>

Large PRs are automatically split into 50K character chunks:

```
Chunk 1/3 → Z.ai API → Review part 1
Chunk 2/3 → Z.ai API → Review part 2  
Chunk 3/3 → Z.ai API → Review part 3
                    ↓
          Combined comment posted to PR
```

</details>

<details>
<summary>Deduplication Strategies</summary>

The action prevents duplicate comments through:

1. **Cross-chunk deduplication** - Same file:line:body posted only once
2. **Location-aware matching** - Repeated fixes at different locations remain actionable
3. **Thread detection** - Replies to existing threads instead of creating duplicates
4. **Resolved filtering** - Skips suggestions where thread is already resolved

</details>

---

## 📄 Other Resources

- [CONTRIBUTING.md](CONTRIBUTING.md) - Contribution guidelines
- [AGENTS.md](AGENTS.md) - Development documentation for AI assistants
- [CHANGELOG.md](CHANGELOG.md) - Version history
- [LICENSE](LICENSE) - MIT License
