const SecurityCheck = require('./SecurityCheck');

// Routes each review chunk to a deep or fast model tier, and decides which
// fast-reviewed chunks get re-reviewed by the deep model.
//
// The two mechanisms are deliberately layered:
// - Up-front routing is path-based only. Paths that carry security or
//   supply-chain weight (CI plumbing, manifests, auth/crypto, shell scripts,
//   key material) go straight to the deep model.
// - Escalation is the second pass. A fast-reviewed chunk is re-reviewed by the
//   deep model when the static security patterns trip on its diff or the fast
//   review itself flags a security issue, so both models see risky code while
//   cost stays proportional to risk.

const MODEL_LABEL_PREFIX = 'zai-model:';
const MODEL_TIERS = new Set(['deep', 'fast']);
const LABEL_TIER_ALIASES = { flash: 'fast' };

// Whole-path rules. Order matters only for the logged reason.
const DEEP_PATH_RULES = [
  { pattern: /^\.github\//i, reason: 'CI/automation configuration' },
  { pattern: /(^|\/)(scripts?|bin|tools?|ci|deploy|infra|terraform|k8s|helm|packaging)\//i, reason: 'automation or deployment path' },
  { pattern: /\.(sh|bash|zsh|ps1|bat|cmd)$/i, reason: 'shell script' },
  { pattern: /\.(pem|key|keystore|jks|p12|pfx|crt|cer|der|gpg|asc)$/i, reason: 'key or certificate material' },
  { pattern: /(^|\/)\.env(\.|$)/i, reason: 'environment file' },
  {
    pattern: /(^|\/)(dockerfile[^/]*|docker-compose[^/]*\.ya?ml|makefile|cmakelists\.txt|id_rsa[^/]*|id_ed25519[^/]*|authorized_keys|known_hosts|codeowners|dependabot\.ya?ml)$/i,
    reason: 'build, container, or access-control file',
  },
  {
    pattern: /(^|\/)(package\.json|pubspec\.yaml|cargo\.toml|go\.mod|go\.sum|requirements[^/]*\.txt|pipfile(\.lock)?|gemfile(\.lock)?|podfile(\.lock)?|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|gradle-wrapper\.properties|proguard-rules\.pro|androidmanifest\.xml|analysis_options\.yaml|packages\.config|\.npmrc|\.yarnrc)$/i,
    reason: 'manifest or build configuration',
  },
];

// Path components whose names carry security weight. Matched on individual
// path segments so `src/session/store.js` and `auth/token.dart` route deep
// while `design/assignments.md` does not.
const DEEP_SEGMENT_PATTERN =
  /(^|[^a-z])(auth|oauth|jwt|crypto|crypt|tls|ssl|cert|certificate|keystore|keychain|keyring|sign|signing|secret|credential|token|password|passwd|permission|security|vault|encrypt|decrypt|session|payment|billing|invoice)([^a-z]|$)/i;

// Security signals in a fast review's own output that promote the chunk to a
// deep re-review. Over-matching only costs one extra request, so this errs
// toward escalation.
const ESCALATION_KEYWORD_PATTERN =
  /\b(vulnerab\w*|exploit\w*|injection\b|insecure\b|xss\b|csrf\b|ssrf\b|rce\b|xxe\b|remote code execution|sql injection|command injection|path traversal|directory traversal|hardcoded (secret|password|credential|key|token)|api[_ -]?key|secret key|credentials?\b|token leak|cleartext|plaintext (password|secret|token|key)|privilege escalation|unauthorized access|auth(entication|orization)? bypass|unsanitized|unescaped|insecure deserializ\w*|man[- ]in[- ]the[- ]middle|\bmitm\b|weak crypto\w*|insecure random|predictable (token|secret|id)|md5|sha-?1\b|buffer overflow|out-of-bounds|use-after-free|integer overflow|race condition|toctou|open redirect|header injection|prototype pollution|reentrancy|supply[- ]chain)/i;

function normalizeLabelNames(labels = []) {
  return labels
    .map(label => (typeof label === 'string' ? label : label?.name))
    .filter(Boolean)
    .map(label => label.trim().toLowerCase());
}

// Parses zai-model:deep / zai-model:flash PR labels into a whole-PR tier
// override, mirroring resolveReviewMode's zai-review:* convention. Conflicting
// labels resolve to the deeper review.
function resolveModelRoute(labels = []) {
  const labelTiers = new Set(
    normalizeLabelNames(labels)
      .filter(label => label.startsWith(MODEL_LABEL_PREFIX))
      .map(label => label.slice(MODEL_LABEL_PREFIX.length))
      .map(tier => LABEL_TIER_ALIASES[tier] || tier)
      .filter(tier => MODEL_TIERS.has(tier))
  );
  const tier = labelTiers.has('deep') ? 'deep' : labelTiers.has('fast') ? 'fast' : null;
  return { tier, labelTiers: [...labelTiers] };
}

function deepPathReason(filename) {
  for (const rule of DEEP_PATH_RULES) {
    if (rule.pattern.test(filename)) {
      return rule.reason;
    }
  }

  const securitySegment = filename
    .split('/')
    .find(segment => DEEP_SEGMENT_PATTERN.test(segment));
  if (securitySegment) {
    return `security-sensitive path segment "${securitySegment}"`;
  }

  return '';
}

// Classifies one chunk by file paths only. Diff content is checked later by
// the escalation pass, so pattern-tripping chunks are seen by both models.
function classifyChunk(files = []) {
  const reasons = [];
  for (const file of files) {
    const filename = file?.filename || '';
    if (!filename) continue;
    const reason = deepPathReason(filename);
    if (reason) {
      reasons.push(`${filename} (${reason})`);
    }
  }
  return { tier: reasons.length > 0 ? 'deep' : 'fast', reasons };
}

// Decides whether a chunk the fast model already reviewed should be
// re-reviewed by the deep model: static security findings on the chunk's diff,
// or security language in the fast review's own findings.
function needsDeepReview(files = [], rawReview = '', customPatterns = []) {
  const reasons = [];

  const findings = SecurityCheck.checkSecurity(files, customPatterns);
  if (findings.length > 0) {
    reasons.push(`${findings.length} static security finding(s)`);
  }

  if (ESCALATION_KEYWORD_PATTERN.test(rawReview || '')) {
    reasons.push('security issue flagged in fast review findings');
  }

  return { escalate: reasons.length > 0, reasons };
}

module.exports = {
  MODEL_LABEL_PREFIX,
  resolveModelRoute,
  classifyChunk,
  needsDeepReview,
  DEEP_PATH_RULES,
  DEEP_SEGMENT_PATTERN,
  ESCALATION_KEYWORD_PATTERN,
};
