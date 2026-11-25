import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseDecoder, parseSseData, describeGatewayError, redactKey, parseModels } from '../../public/chat-sse.js';

test('parser SSE do chat aceita eventos divididos, comentarios e multiple linhas data', () => {
  const decoder = createSseDecoder();
  const chunks = [': ping\n\n', 'data: {"choices":[{"delta":{"', 'content":"Olá "}}]}\n', '\ndata: {"choices":[{"delta":{"content":"mundo"}}]}\n\n', 'data: [DONE]\n\n'];
  const events = chunks.flatMap(chunk => decoder.push(chunk)).concat(decoder.flush());
  assert.deepEqual(events.map(event => parseSseData(event.data, event.event)), [
    { type: 'delta', text: 'Olá ' },
    { type: 'delta', text: 'mundo' },
    { type: 'done' },
  ]);
});

test('parser SSE do chat distingue erro, dado fora do contrato e texto final sem nova linha', () => {
  const decoder = createSseDecoder();
  const events = decoder.push('event: error\ndata: {"message": "falha"}\n\ndata: linha-livre\n\n').concat(decoder.flush());
  assert.deepEqual(events.map(event => parseSseData(event.data, event.event)), [
    { type: 'error', message: 'falha' },
    { type: 'ignore' },
  ]);
  const tail = createSseDecoder();
  assert.deepEqual(tail.push('data: {"choices":[{"message":{"content":"final"}}]}').concat(tail.flush())
    .map(event => parseSseData(event.data, event.event)), [{ type: 'delta', text: 'final' }]);
});

test('mensagens de erro do chat tem fallback por status, redacao de chave e catalogo validado', () => {
  assert.equal(describeGatewayError(401, null), 'Chave Anubis invalida ou sem acesso ao gateway.');
  assert.equal(describeGatewayError(402, null), 'Plano ou creditos insuficientes no gateway.');
  assert.equal(describeGatewayError(429, { error: { message: 'muitas chamadas' } }), 'muitas chamadas');
  assert.equal(describeGatewayError(500, null), 'Nenhum destino do fornecedor esta disponivel no momento.');
  const key = 'anubis_segredo123';
  assert.equal(redactKey(`acesso negado para ${key}`, key), 'acesso negado para [redacted]');
  assert.deepEqual(parseModels({ data: [{ id: 'a' }, { id: 'a' }, {}, { id: 7 }] }), ['a']);
  assert.throws(() => parseModels({ data: 'errado' }), /catalogo inesperado/);
});
