import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mergeUsage, usageObserver, summarizeUsage, estimateInputTokens, finalizeUsage } from '../src/usage.js';

test('observa uso em JSON e SSE sem alterar conteúdo, inclusive blocos divididos', async () => {
  const usage = {}; let forwarded = '';
  const chunks = ['data: {"message":{"usage":{"input_', 'tokens":25,"cache_read_input_tokens":10}}}\n\n', 'data: {"usage":{"output_tokens":7}}\n\n', 'data: [DONE]\n\n'];
  await pipeline(Readable.from(chunks), usageObserver('text/event-stream', usage), new Writable({ write(chunk, _enc, done) { forwarded += chunk.toString(); done(); } }));
  assert.equal(forwarded, chunks.join('')); assert.deepEqual(usage, { inputTokens: 25, cachedInputTokens: 10, outputTokens: 7 });
  const jsonUsage = {}; let jsonForwarded = '';
  const content = JSON.stringify({ usage: { prompt_tokens: 8, completion_tokens: 2 }, choices: [{ message: { content: 'privado' } }] });
  await pipeline(Readable.from([content.slice(0, 20), content.slice(20)]), usageObserver('application/json', jsonUsage), new Writable({ write(chunk, _enc, done) { jsonForwarded += chunk.toString(); done(); } }));
  assert.equal(jsonForwarded, content); assert.deepEqual(jsonUsage, { inputTokens: 8, outputTokens: 2 });
  assert.deepEqual(mergeUsage({}, { response: { usage: { input_tokens: 42, output_tokens: 5 } } }), { inputTokens: 42, outputTokens: 5 });
  assert.deepEqual(mergeUsage({}, { usage: { prompt_tokens: -1, completion_tokens: '9' } }), {});
});

test('estima tokens de entrada e saída quando o fornecedor omite o uso', async () => {
  assert.equal(estimateInputTokens({ messages: [{ role: 'user', content: 'oi' }] }), 5);
  assert.equal(estimateInputTokens({ messages: [{ role: 'user', content: 'a'.repeat(4000) }] }), 1004);
  const usage = {}; const counters = { outputChars: 0 };
  await pipeline(
    Readable.from(['data: {"choices":[{"delta":{"content":"abcdefgh"}}]}\n\n']),
    usageObserver('text/event-stream', usage, null, counters),
    new Writable({ write(_chunk, _encoding, done) { done(); } }),
  );
  finalizeUsage(usage, { inputTokens: 12, outputChars: counters.outputChars });
  assert.deepEqual(usage, { inputTokens: 12, outputTokens: 2, estimated: true });
  const measured = { inputTokens: 5, outputTokens: 7 };
  finalizeUsage(measured, { inputTokens: 100, outputChars: 400 });
  assert.deepEqual(measured, { inputTokens: 5, outputTokens: 7 });
  const empty = {}; finalizeUsage(empty, { inputTokens: 0, outputChars: 0 });
  assert.deepEqual(empty, {});
});

test('resume solicitações sem tratar token ausente como medição válida', () => {
  const records = [{ provider: 'a', connectionId: '1', upstreamModel: 'm', status: 'completed', usage: { inputTokens: 10 } }, { provider: 'a', connectionId: '1', upstreamModel: 'm', status: 'cancelled', usage: {} }];
  const { groups } = summarizeUsage(records); assert.equal(groups[0].requests, 2); assert.equal(groups[0].inputReported, 1); assert.equal(groups[0].outputReported, 0); assert.equal(groups[0].cancelled, 1);
});
