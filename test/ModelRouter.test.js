const ModelRouter = require('../src/review/ModelRouter');

describe('ModelRouter', () => {
  describe('resolveModelRoute', () => {
    it('returns no override without model labels', () => {
      const result = ModelRouter.resolveModelRoute([{ name: 'bug' }, 'enhancement']);
      expect(result.tier).toBeNull();
      expect(result.labelTiers).toEqual([]);
    });

    it('maps zai-model:deep to the deep tier', () => {
      expect(ModelRouter.resolveModelRoute(['zai-model:deep']).tier).toBe('deep');
    });

    it('maps zai-model:flash to the fast tier', () => {
      expect(ModelRouter.resolveModelRoute([{ name: 'zai-model:flash' }]).tier).toBe('fast');
    });

    it('prefers deep when labels conflict', () => {
      const result = ModelRouter.resolveModelRoute(['zai-model:flash', 'zai-model:deep']);
      expect(result.tier).toBe('deep');
      expect(result.labelTiers).toEqual(expect.arrayContaining(['deep', 'fast']));
    });

    it('ignores unknown zai-model values and unrelated labels', () => {
      const result = ModelRouter.resolveModelRoute(['zai-model:turbo', 'zai-review:full']);
      expect(result.tier).toBeNull();
    });
  });

  describe('classifyChunk', () => {
    it('routes empty and code-only chunks to fast', () => {
      expect(ModelRouter.classifyChunk([]).tier).toBe('fast');
      expect(
        ModelRouter.classifyChunk([
          { filename: 'src/main.dart', patch: '+x' },
          { filename: 'lib/util/helpers.js', patch: '+y' },
          { filename: 'docs/guide.md', patch: '+z' },
        ]).tier
      ).toBe('fast');
    });

    it('routes CI workflow changes to deep', () => {
      const result = ModelRouter.classifyChunk([
        { filename: '.github/workflows/release.yml', patch: '+x' },
        { filename: 'src/app.js', patch: '+y' },
      ]);
      expect(result.tier).toBe('deep');
      expect(result.reasons[0]).toContain('.github/workflows/release.yml');
    });

    it('routes shell scripts and automation paths to deep', () => {
      for (const filename of ['scripts/release.sh', 'deploy/apply.sh', 'bin/install.bash']) {
        expect(ModelRouter.classifyChunk([{ filename, patch: '+x' }]).tier).toBe('deep');
      }
    });

    it('routes manifests and build configuration to deep', () => {
      for (const filename of [
        'package.json',
        'app/pubspec.yaml',
        'android/app/build.gradle.kts',
        'gradle.properties',
        'AndroidManifest.xml',
        'go.mod',
      ]) {
        expect(ModelRouter.classifyChunk([{ filename, patch: '+x' }]).tier).toBe('deep');
      }
    });

    it('routes security-sensitive path segments to deep', () => {
      for (const filename of [
        'src/auth/login.dart',
        'lib/crypto/keys.js',
        'net/session_manager.kt',
        'store/token-cache.ts',
      ]) {
        expect(ModelRouter.classifyChunk([{ filename, patch: '+x' }]).tier).toBe('deep');
      }
    });

    it('does not route on accidental substring matches', () => {
      expect(
        ModelRouter.classifyChunk([
          { filename: 'docs/design/assignment.md', patch: '+x' },
          { filename: 'src/designated/driver.js', patch: '+y' },
        ]).tier
      ).toBe('fast');
    });

    it('routes key material and dotenv files to deep', () => {
      for (const filename of ['app/debug.keystore', 'certs/server.pem', '.env.production']) {
        expect(ModelRouter.classifyChunk([{ filename, patch: '+x' }]).tier).toBe('deep');
      }
    });
  });

  describe('needsDeepReview', () => {
    it('escalates when static security patterns trip on the diff', () => {
      const files = [
        { filename: 'src/config.js', patch: '+api_key = "abcdef1234567890abcd"' },
      ];
      const result = ModelRouter.needsDeepReview(files, 'Looks fine overall.');
      expect(result.escalate).toBe(true);
      expect(result.reasons[0]).toContain('static security finding');
    });

    it('escalates when the fast review flags a security issue', () => {
      const review = '## [Major] src/net.js:10 - Unsafe request\n**Problem:** Possible SQL injection.';
      const result = ModelRouter.needsDeepReview(
        [{ filename: 'src/net.js', patch: '+x' }],
        review
      );
      expect(result.escalate).toBe(true);
      expect(result.reasons.some(r => r.includes('fast review'))).toBe(true);
    });

    it('does not escalate clean reviews', () => {
      const files = [{ filename: 'src/util.js', patch: '+const x = 1;' }];
      const result = ModelRouter.needsDeepReview(files, 'The changes look correct and well tested.');
      expect(result.escalate).toBe(false);
      expect(result.reasons).toEqual([]);
    });

    it('honors custom security patterns', () => {
      const files = [{ filename: 'src/x.js', patch: '+dangerous_call()' }];
      const result = ModelRouter.needsDeepReview(files, 'fine', [
        { pattern: 'dangerous_call', message: 'custom', severity: 'high' },
      ]);
      expect(result.escalate).toBe(true);
    });
  });
});
