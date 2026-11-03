import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildEnv, CLAUDE } = await import('../out/profiles.js');

test('claudeEnv overrides a stripped ambient CLAUDE_CODE_* value', () => {
  const env = buildEnv(
    { PATH: '/bin', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '5000' },
    CLAUDE,
    undefined,
    { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000' },
  );
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
  assert.equal(env.PATH, '/bin');
});

test('profile env overrides claudeEnv; unrelated ambient vars survive', () => {
  const env = buildEnv(
    { PATH: '/bin', HOME: '/home/u', ANTHROPIC_API_KEY: 'ambient' },
    { id: 'glm', label: 'GLM', baseUrl: 'https://e.test', env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '42' } },
    'key-123',
    { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '100', HOME: '/overridden' },
  );
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '42');
  assert.equal(env.HOME, '/overridden');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'key-123');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://e.test');
});

test('invalid env keys are skipped', () => {
  const env = buildEnv({}, CLAUDE, undefined, { 'bad-key': 'x', GOOD_KEY: 'y' });
  assert.equal(env['bad-key'], undefined);
  assert.equal(env.GOOD_KEY, 'y');
});
