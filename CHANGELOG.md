# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.9] - 2026-07-12

### Added
- File exclusion patterns and an optional total diff budget, based on upstream's large-PR controls
- Visible coverage notes for excluded, patchless, budget-skipped, and truncated files
- Node 20 and Node 24 CI coverage with committed bundle verification

### Fixed
- Inline suggestion threading no longer fails from a circular module dependency
- Oversized individual patches are bounded instead of exceeding the per-request chunk limit
- API retries now stop on permanent 4xx responses and honor bounded `Retry-After` delays
- Resolved review threads are read from GitHub's GraphQL API and comment lookups are fully paginated
- Custom security patterns are included in the posted review, not only workflow logs
- Finding summaries preserve file and line locations, and findings after an outside-diff item are classified correctly
- Identical fixes at different locations are no longer incorrectly deduplicated
- Runtime dependencies were updated to remove known production vulnerabilities

### Changed
- Release creation now waits for successful CI and publishes only prewritten changelog content
- The deprecated feedback-commit input no longer runs unsafe Git commands from a pull request action

## [0.0.8] - 2026-03-28

### Fixed
- Final PR comments now disclose partial review coverage when one or more chunks fail
  - Adds a visible caution banner so reviewers can see incomplete chunk coverage without opening the action log
  - Prevents partially merged reviews from appearing complete when failed chunks were omitted
- Chunk merge summary logging now distinguishes successful chunks from failed chunks
  - Replaces the previous total-only merge summary with explicit success and failure counts
- Retry diagnostics now include richer chunk context for timeout and socket reset failures
  - Logs chunk position, file count, oversized-file count, patch size, prompt size, and elapsed time per failed attempt
- Added regression coverage for partial chunk failures in the final merged review body
  - Tests the caution banner path and the new formatting helpers used by the main run loop

## [0.0.7] - 2026-03-27

### Fixed
- Combined review parsing now handles real multi-chunk output syntax instead of only idealized bracketed findings
  - Plain severity banners like `## BLOCKER` and `## Minor` now establish grouping context for following findings
  - Contextual heading-style findings like `### file:line - title` and bold titles are now parsed under the active severity section
  - Narrative filler and chunk markers no longer leak into the previous finding body
- Review prompt contract hardened to reduce malformed chunk output
  - Forbids conversational introductions, praise, summaries, and sign-offs in chunk responses
  - Forbids standalone severity banners and chunk or part headings in model output
  - Instructs the model to omit findings it cannot express in the required structure instead of falling back to free-form commentary
- Added regression coverage for production-style combined chunk syntax
  - Tests now cover the noisy response shapes observed in v0.0.6 combined comments
  - Prevents future regressions where grouping passes synthetic tests but fails on real chunk output
- GitHub Action runtime migrated from Node 20 to Node 24
  - Removes the deprecation warning currently emitted by GitHub-hosted runners
  - Aligns the action metadata with the 2026 JavaScript action runtime transition
- README quickstart permissions corrected for the APIs used by the action
  - Documents `issues: write` for the summary PR comment path
  - Keeps `pull-requests: write` for PR review and inline comment behavior

## [0.0.6] - 2026-03-27

### Fixed
- Chunk combination now properly groups findings by severity across all chunks
  - Removed structural chunk headers (`### Chunk X/Y`) from combined review text
  - Added boundary detection in `parseFindings()` to terminate findings at chunk separators
  - Chunk headers and `---` separators no longer leak into finding content fields
- Section header parsing now captures inline content on the same line
  - `**Problem:**`, `**Impact:**`, `**Suggested fix:**`, and `**Prompt for AI Agents:**` now retain content after the colon on the same line
- SecurityCheck now reports correct line numbers using diff hunk headers (`@@`)
  - Previously counted diff headers and context lines, causing wrong line numbers
- Oversized files (>50KB patch) are now flagged with `oversized` marker and isolated into their own chunk
  - Warnings logged for oversized files to alert users of potentially incomplete reviews
- Pagination added to `filterResolvedSuggestions` to handle PRs with 100+ resolved comments
- Thread similarity threshold now validated to 0-1 range with fallback to default 0.6
- Head SHA validated early with warning if missing
- All review chunks failing now aborts with `core.setFailed` instead of posting empty review
- Low severity security findings now map to `MINOR` instead of `INFO`
  - Prevents empty sections when AI outputs content on the header line

## [0.0.5] - 2026-03-21

### Fixed
- Multi-chunk review summaries now preserve severity grouping across all chunks
  - Combined summary parsing now uses raw chunk output instead of post-processed text
  - Severity parsing now tolerates bullet-prefixed headings from chunk formatting
- Inline suggestion threading now replies to an existing thread at most once per run
  - Additional findings at the same file and line are posted as separate review comments
  - Prevents unrelated inline suggestions from nesting under the first matching thread

## [0.0.4] - 2026-03-20

### Added
- Enhanced review formatting with Coderabbit-style collapsible severity sections
  - `formatReview()` groups findings by severity (Critical, Major, Minor, Info)
  - Collapsible `<details>` sections for cleaner PR comments
  - Actionable comment count in review header
- Outside-diff comment separation and grouping
  - `separateOutsideDiffComments()` identifies comments outside diff range
  - Grouped by file in collapsible section
- Smart deduplication (cross-chunk)
  - `hashString()` for content-based deduplication
  - Prevents duplicate suggestions across PR review chunks
  - File:line:body deduplication logic
- Comment threading support
  - `getExistingCommentThreads()` fetches existing review threads
  - `findSimilarThread()` with configurable similarity threshold (0.6)
  - `calculateSimilarity()` for thread matching
- Custom security patterns system
  - `loadCustomPatterns()` reads `.zai-review.yaml` config file
  - Simple YAML parser for `security_patterns` section
  - `categorizeSeverity()` maps patterns to severity levels
  - Custom patterns merged with built-in checks
  - Example config file: `.zai-review.yaml.example`
- Configurable thread similarity threshold
  - New input: `ZAI_THREAD_SIMILARITY_THRESHOLD` (default: 0.6)
  - Allows tuning of thread matching sensitivity
- Outside-diff separation
  - `separateOutsideDiffComments()` identifies outside-diff markers
  - `formatOutsideDiffSection()` creates grouped collapsible sections
  - Groups comments by file for organization
  - Preserves full comment content
- Resolved comment filtering
  - `filterResolvedSuggestions()` prevents reposting resolved issues
  - Checks `comment.state === 'RESOLVED'`
  - Builds file:line key set of resolved IDs
  - Graceful fallback if API call fails
- Improved system prompt with format instructions
  - Instructs AI to use severity markers
  - Requests (outside diff) marking for appropriate comments
  - Clear structured output guidance
- Comprehensive integration test suite
  - Tests for custom patterns loading and YAML parsing
  - Threading integration tests with similarity matching
  - Suggestion deduplication across chunks
  - Resolved comment filtering
  - Security check integration with custom patterns

### Fixed
- **Wired up dead code**: `formatReview()` and `separateOutsideDiffComments()` are now called in the main flow
- Resolved comment filtering now properly integrated before posting suggestions
- CHANGELOG v0.0.1 section: removed duplicate entries

### Changed
- Security patterns refactored into configurable system
  - Built-in patterns extracted to `getBuiltInPatterns()` method
  - `checkSecurity()` now accepts optional custom patterns array
  - Invalid regex patterns in custom config are silently skipped

## [0.0.3] - 2026-03-19

### Added
- review helper modules for conversational feedback, static security checks, inline suggestions, and feedback filtering
- unit coverage for the new helper modules and inline suggestion extraction

### Fixed
- inline suggestions are now best-effort so invalid GitHub review anchors no longer fail the entire action run
- release automation now requests `contents: write` before creating releases and pushing changelog updates
- package, lockfile, changelog, and usage examples are aligned for the `v0.0.3` release

## [0.0.2] - 2026-03-19

### Changed
- fix: remove dist/ from gitignore and add to git for GitHub Actions releases
- docs: simplify README with unified workflow example

## [0.0.1] - 2026-03-18

### Added
- Automatic diff chunking for large PRs that exceed API token limits
  - `MAX_CHUNK_SIZE` constant (50K characters per chunk)
  - `splitIntoChunks()` function to divide files by diff size
  - `buildChunkPrompt()` for chunk-aware prompts with progress tracking
  - Partial chunk error handling with graceful degradation
- Retry logic with exponential backoff (`callZaiApiWithRetry()`)
  - Configurable via `RETRY_CONFIG` constant (3 retries, 1-8s delays)
- Comprehensive test suite with Jest (8 tests covering core functionality)
- ESLint configuration for code style enforcement
- CI workflow (`.github/workflows/ci.yml`) for automated lint, test, and build
- `AGENTS.md` for AI coding assistants and project contributors
- Comprehensive error logging for multi-chunk processing

### Changed
- **CRITICAL**: Error messages no longer expose API response data (security hardening)
- Standardized all error messages with `ERR_PREFIX` constant
- Extracted magic numbers as named constants (`PER_PAGE`, `MAX_CHUNK_SIZE`)
- Pinned `@vercel/ncc` to exact version `0.38.1`
- Removed hardcoded model validation - users can use any Z.ai model via `ZAI_MODEL` input
- Version reset from 0.3.0 to 0.0.1 (fork initialization from tarmojussila/zai-code-review)
- Repository rebranded to bizzkoot/zai-code-review
- Enhanced error messages with standardized prefix
- Improved defensive programming with empty chunk validation

### Fixed
- **CRITICAL**: API error 1261 (prompt exceeds max length) by implementing automatic chunking
- Edge case where PRs with no patchable files would fail silently
- Total data loss in multi-chunk reviews when individual chunks failed
  - Now provides partial results with error messages for failed chunks

### Security
- **CRITICAL**: Error messages no longer expose API response data (prevents information disclosure)
- Retry logic for transient failure handling
- Maintained secure secret handling with `core.setSecret()`
- Response size limits enforced (1MB cap)
- Request timeout protection (300 seconds)

[0.0.1]: https://github.com/bizzkoot/zai-code-review/releases/tag/v0.0.1

[0.0.2]: https://github.com/bizzkoot/zai-code-review/releases/tag/v0.0.2

[0.0.3]: https://github.com/bizzkoot/zai-code-review/releases/tag/v0.0.3

[0.0.9]: https://github.com/L-K-M/zai-code-review/releases/tag/v0.0.9
