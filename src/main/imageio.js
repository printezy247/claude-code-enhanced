// A composer image the page wants copied or saved: check it before it touches disk or the clipboard.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

function decodeImage(p) {
  const ext = p && EXT[p.media_type];
  if (!ext) return { ok: false, error: 'That image type is not supported.' };
  const buffer = Buffer.from(String(p.data || ''), 'base64');
  if (!buffer.length) return { ok: false, error: 'The image is empty.' };
  if (buffer.length > MAX_IMAGE_BYTES) return { ok: false, error: 'The image is too large.' };
  return { ok: true, buffer, ext };
}

module.exports = { decodeImage, MAX_IMAGE_BYTES };
