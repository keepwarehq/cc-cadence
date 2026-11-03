import { randomBytes } from 'node:crypto';
import type { InputBlock } from './runner';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/** Content blocks for a message: image blocks first, then one text block carrying the attached-file list */
export function buildBlocks(
  text: string,
  images: { mediaType: string; base64: string }[],
  filePaths: string[],
): InputBlock[] {
  const blocks: InputBlock[] = images.map(im => ({
    type: 'image',
    source: { type: 'base64', media_type: im.mediaType, data: im.base64 },
  }));
  const suffix = filePaths.length ? '\n\n' + filePaths.map(p => `- attached file: ${p}`).join('\n') : '';
  blocks.push({ type: 'text', text: text + suffix });
  return blocks;
}

/** Size/type gate for image attachments */
export function validateImage(sizeBytes: number, mediaType = 'image/png'): boolean {
  return (IMAGE_TYPES as readonly string[]).includes(mediaType) && sizeBytes <= MAX_IMAGE_BYTES;
}

let attachmentSeq = 0;
export function nextAttachmentId(): string {
  return `a${Date.now().toString(36)}${(attachmentSeq++).toString(36)}${randomBytes(2).toString('hex')}`;
}
