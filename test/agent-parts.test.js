'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildParts, parseDataUrl } = require('../src/agent-parts');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const WEBM = 'data:audio/webm;base64,GkXfo0=';

test('text only returns the bare prompt string', () => {
  assert.equal(buildParts({ prompt: 'hello' }), 'hello');
});

test('parseDataUrl splits media type and payload', () => {
  assert.deepEqual(parseDataUrl(PNG), { mediaType: 'image/png', data: 'iVBORw0KGgo=' });
  assert.equal(parseDataUrl('not-a-data-url'), null);
});

test('an image becomes a user message with a text part and an image part', () => {
  const msg = buildParts({ prompt: 'read this', image: PNG });
  assert.equal(msg.role, 'user');
  assert.equal(msg.content[0].type, 'text');
  assert.equal(msg.content[1].type, 'image');
  assert.equal(msg.content[1].mediaType, 'image/png');
});

test('audio becomes a file part with its media type', () => {
  const msg = buildParts({ prompt: 'hear this', audio: WEBM });
  assert.equal(msg.content[1].type, 'file');
  assert.equal(msg.content[1].mediaType, 'audio/webm');
});

test('image and audio together produce three parts', () => {
  const msg = buildParts({ prompt: 'both', image: PNG, audio: WEBM });
  assert.equal(msg.content.length, 3);
});

test('a malformed data url is ignored rather than sent', () => {
  assert.equal(buildParts({ prompt: 'p', image: 'garbage' }), 'p');
});

test('parseDataUrl handles MediaRecorder-style params before base64 (e.g. codecs)', () => {
  assert.deepEqual(
    parseDataUrl('data:audio/webm;codecs=opus;base64,GkXfo0='),
    { mediaType: 'audio/webm', data: 'GkXfo0=' }
  );
});

test('image without prompt produces a valid message with no empty text part', () => {
  const msg = buildParts({ image: PNG });
  assert.equal(msg.role, 'user');
  assert.equal(msg.content.length, 1);
  assert.equal(msg.content[0].type, 'image');
  // Ensure no invalid text part with undefined/missing text key
  const textPart = msg.content.find(p => p.type === 'text');
  assert.equal(textPart, undefined, 'should not include an empty text part');
});

test('audio without prompt produces a valid message with no empty text part', () => {
  const msg = buildParts({ audio: WEBM });
  assert.equal(msg.role, 'user');
  assert.equal(msg.content.length, 1);
  assert.equal(msg.content[0].type, 'file');
  // Ensure no invalid text part with undefined/missing text key
  const textPart = msg.content.find(p => p.type === 'text');
  assert.equal(textPart, undefined, 'should not include an empty text part');
});

test('image and audio without prompt produces valid parts without empty text', () => {
  const msg = buildParts({ image: PNG, audio: WEBM });
  assert.equal(msg.role, 'user');
  assert.equal(msg.content.length, 2);
  assert.equal(msg.content[0].type, 'image');
  assert.equal(msg.content[1].type, 'file');
  const textPart = msg.content.find(p => p.type === 'text');
  assert.equal(textPart, undefined, 'should not include an empty text part');
});
