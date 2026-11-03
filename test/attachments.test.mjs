import { test } from 'node:test';
import assert from 'node:assert/strict';

const { MAX_IMAGE_BYTES, buildBlocks, validateImage, nextAttachmentId, isImageType, classifyAttachment, stagedName } = await import('../out/attachments.js');

test('buildBlocks puts image blocks first, then one text block with the attached-file list', () => {
  const blocks = buildBlocks('look at this', [{ mediaType: 'image/png', base64: 'aGk=' }], ['docs/spec.md', 'notes.txt']);
  assert.deepEqual(blocks, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
    { type: 'text', text: 'look at this\n\n- attached file: docs/spec.md\n- attached file: notes.txt' },
  ]);
});

test('buildBlocks with no attachments is a single text block', () => {
  assert.deepEqual(buildBlocks('hello', [], []), [{ type: 'text', text: 'hello' }]);
});

test('validateImage rejects images over MAX_IMAGE_BYTES', () => {
  assert.equal(MAX_IMAGE_BYTES, 5 * 1024 * 1024);
  assert.equal(validateImage(MAX_IMAGE_BYTES), true);
  assert.equal(validateImage(MAX_IMAGE_BYTES + 1), false);
});

test('validateImage only accepts the four image types the API takes', () => {
  assert.equal(validateImage(100, 'image/png'), true);
  assert.equal(validateImage(100, 'image/jpeg'), true);
  assert.equal(validateImage(100, 'image/webp'), true);
  assert.equal(validateImage(100, 'image/gif'), true);
  assert.equal(validateImage(100, 'image/svg+xml'), false);
});

test('nextAttachmentId produces unique ids', () => {
  const a = nextAttachmentId();
  const b = nextAttachmentId();
  assert.notEqual(a, b);
  assert.ok(a.length > 4);
});

test('isImageType matches only the four API image types', () => {
  assert.equal(isImageType('image/png'), true);
  assert.equal(isImageType('image/svg+xml'), false);
});

test('classifyAttachment rejects oversized images, accepts image types by name fallback', () => {
  assert.equal(classifyAttachment('shot.png', 'image/png', 6 * 1024 * 1024), 'reject');
  assert.equal(classifyAttachment('shot.png', 'image/png', 100), 'image');
  assert.equal(classifyAttachment('notes.txt', 'text/plain', 100), 'file');
  assert.equal(classifyAttachment('shot.png', undefined, 100), 'image');
  assert.equal(classifyAttachment('shot.png', 'image/svg+xml', 100), 'file');
});

test('stagedName is unique per uid and sanitizes the file name', () => {
  assert.notEqual(stagedName('config.json', 'u1'), stagedName('config.json', 'u2'));
  assert.equal(stagedName('my file (1).pdf', 'u1'), 'u1-my_file_1_.pdf');
});
