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

test('resolveModel maps selection through profile aliases', async () => {
  const { resolveModel, modelChoices } = await import('../out/profiles.js');
  const claude = { id: 'claude', label: 'Claude (Max)' };
  assert.equal(resolveModel(claude, undefined), undefined);
  assert.equal(resolveModel(claude, 'default'), undefined);
  assert.equal(resolveModel(claude, 'opus'), 'opus');
  assert.equal(resolveModel(claude, 'fable'), 'fable');
  const glm = { id: 'g', label: 'G', baseUrl: 'https://e.test', model: 'glm-x', models: { sonnet: 'glm-s', opus: 'glm-o' } };
  assert.equal(resolveModel(glm, 'default'), 'glm-x');
  assert.equal(resolveModel(glm, 'sonnet'), 'glm-s');
  assert.equal(resolveModel(glm, 'haiku'), 'glm-x');
  assert.deepEqual(modelChoices(claude), ['default', 'opus', 'sonnet', 'haiku', 'fable']);
  assert.deepEqual(modelChoices(glm), ['default', 'sonnet', 'opus']);
});

test('effort levels match claude --effort', async () => {
  const { EFFORT_LEVELS, effortChoices } = await import('../out/profiles.js');
  assert.deepEqual([...EFFORT_LEVELS], ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(effortChoices(), ['default', 'low', 'medium', 'high', 'xhigh', 'max']);
});
