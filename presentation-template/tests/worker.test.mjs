import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeActivity, summarizePoll } from '../src/worker.js';

test('normaliza atividades desconhecidas para o palco', () => {
  assert.equal(normalizeActivity('poll:warmup'), 'poll:warmup');
  assert.equal(normalizeActivity('invalid:value'), 'stage');
});

test('resume votos de escolha única', () => {
  const config = {
    type: 'single',
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' }
    ]
  };
  const result = summarizePoll(config, {
    open: true,
    byDevice: { one: 'a', two: 'a', three: 'b', invalid: 'c' }
  });

  assert.deepEqual(result, {
    open: true,
    responses: 3,
    counts: { a: 2, b: 1 },
    average: 0
  });
});

test('resume votos de escolha múltipla', () => {
  const config = {
    type: 'multiple',
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' }
    ]
  };
  const result = summarizePoll(config, {
    open: false,
    byDevice: {
      one: { a: true, b: true },
      two: { b: true },
      empty: {}
    }
  });

  assert.equal(result.open, false);
  assert.equal(result.responses, 2);
  assert.deepEqual(result.counts, { a: 1, b: 2, c: 0 });
  assert.equal(result.average, 1.5);
});
