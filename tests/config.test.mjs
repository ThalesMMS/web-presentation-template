import assert from 'node:assert/strict';
import test from 'node:test';

import { CONFIG } from '../public/presentation.config.js';
import { activityForSlide } from '../public/assets/activity.js';

test('a configuração possui slides e enquetes válidos', () => {
  assert.ok(CONFIG.title.trim());
  assert.ok(Array.isArray(CONFIG.slides));
  assert.ok(CONFIG.slides.length > 0);

  for (const [key, poll] of Object.entries(CONFIG.polls)) {
    assert.match(key, /^[a-z][a-z0-9_-]*$/);
    assert.ok(poll.question.trim());
    assert.ok(['single', 'multiple'].includes(poll.type));
    assert.ok(Array.isArray(poll.options));
    assert.ok(poll.options.length >= 2);
    const ids = poll.options.map(option => option.id);
    assert.equal(new Set(ids).size, ids.length, `IDs duplicados na enquete ${key}`);
    if (poll.exclusive) assert.ok(ids.includes(poll.exclusive));
  }
});

test('cada slide de enquete aponta para uma enquete existente', () => {
  for (const slide of CONFIG.slides) {
    if (slide.type !== 'poll') continue;
    assert.ok(CONFIG.polls[slide.poll], `Enquete ausente: ${slide.poll}`);
    assert.equal(activityForSlide(slide), `poll:${slide.poll}`);
  }
});

test('as atividades padrão são estáveis', () => {
  assert.equal(activityForSlide({ type: 'cover' }), 'opening');
  assert.equal(activityForSlide({ type: 'statement' }), 'stage');
  assert.equal(activityForSlide({ type: 'closing' }), 'closing');
});
