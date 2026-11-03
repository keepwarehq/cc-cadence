import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resultNotice, resultErrorText } = await import('../out/turnResult.js');

test('a non-success result shows a red error when the turn was not stopped', () => {
  const n = resultNotice({ subtype: 'error_during_execution', result: '[ede_diagnostic] stop_reason=tool_use' }, false);
  assert.deepEqual(n, { level: 'error', text: '[ede_diagnostic] stop_reason=tool_use' });
});

test('a result on a user-stopped turn produces no error notice', () => {
  assert.equal(resultNotice({ subtype: 'error_during_execution', result: '[ede_diagnostic] stop_reason=tool_use' }, true), null);
  assert.equal(resultNotice({ is_error: true, result: 'boom' }, true), null);
});

test('a successful result produces no notice either way', () => {
  assert.equal(resultNotice({ subtype: 'success' }, false), null);
  assert.equal(resultNotice({ subtype: 'success' }, true), null);
});

test('resultErrorText falls back through result, errors, subtype', () => {
  assert.equal(resultErrorText({ result: 'a' }), 'a');
  assert.equal(resultErrorText({ errors: ['x', 'y'] }), 'x\ny');
  assert.equal(resultErrorText({ subtype: 'error_max_turns' }), 'error_max_turns');
  assert.equal(resultErrorText({}), 'Something went wrong');
});
