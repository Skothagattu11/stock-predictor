'use strict';

// Assembles the AI SDK message for a parse call. Text-only input stays a plain
// string so the existing adapter path is untouched; media promotes it to a
// single user message with content parts.

// Matches "data:<mediaType>[;param=value...];base64,<payload>". The optional
// ";param=value" groups absorb codec/parameter suffixes a real browser adds,
// e.g. MediaRecorder's "data:audio/webm;codecs=opus;base64,...." — without
// them that data URL would fail to match and the audio would be silently
// dropped.
const DATA_URL_RE = /^data:([^;,]+)(?:;[^;,]+)*;base64,(.+)$/;

function parseDataUrl(url) {
  if (typeof url !== 'string') return null;
  const m = DATA_URL_RE.exec(url);
  if (!m) return null;
  return { mediaType: m[1], data: m[2] };
}

function buildParts({ prompt, image, audio }) {
  const img = parseDataUrl(image);
  const aud = parseDataUrl(audio);
  if (!img && !aud) return prompt;

  const content = [{ type: 'text', text: prompt }];
  if (img) content.push({ type: 'image', image: img.data, mediaType: img.mediaType });
  if (aud) content.push({ type: 'file', data: aud.data, mediaType: aud.mediaType });
  return { role: 'user', content };
}

module.exports = { buildParts, parseDataUrl };
