import assert from 'node:assert/strict';
import test from 'node:test';

import { CONFIG } from '../public/presentation.config.js';
import { audienceForSlide, paceSchedule, scoredPollKeys, slideById } from '../public/assets/slides.js';

const SLIDE_IDS = ['cover', 'poll-live', 'poll-secret', 'poll-results', 'exam-1', 'exam-1-continued', 'pause', 'exam-2', 'exam-2-results', 'closing'];

test('the template contains the ten contracted slides and four valid polls', () => {
  assert.equal(CONFIG.title, 'Interactive presentation');
  assert.deepEqual(CONFIG.slides.map(slide => slide.id), SLIDE_IDS);
  assert.equal(new Set(SLIDE_IDS).size, CONFIG.slides.length);
  assert.deepEqual(Object.keys(CONFIG.polls), ['region', 'age', 'exam-1', 'exam-2']);
  for (const slide of CONFIG.slides) {
    assert.match(slide.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(['cover', 'content', 'pause', 'closing'].includes(slide.type));
    assert.ok(slide.title.trim());
    for (const key of ['poll', 'audiencePoll']) {
      if (slide[key]) assert.ok(CONFIG.polls[slide[key]], `Missing poll: ${slide[key]}`);
    }
    for (const key of ['exam', 'audienceExam']) {
      if (slide[key]) assert.ok(CONFIG.exams[slide[key]], `Missing exam: ${slide[key]}`);
    }
    for (const key of ['board', 'audienceBoard']) {
      if (slide[key]) assert.ok(CONFIG.boards[slide[key]], `Missing board: ${slide[key]}`);
    }
  }
  for (const [key, poll] of Object.entries(CONFIG.polls)) {
    assert.ok(poll.question.trim());
    assert.equal(poll.type, 'single');
    const ids = poll.options.map(option => option.id);
    assert.ok(ids.length >= 2);
    assert.equal(new Set(ids).size, ids.length, `Duplicate options in ${key}`);
    assert.ok(poll.options.every(option => option.label.trim()));
    if (poll.correct !== undefined) assert.ok(ids.includes(poll.correct));
  }
  assert.deepEqual(CONFIG.polls.region.options.map(option => option.id), ['north', 'northeast', 'midwest', 'southeast', 'south', 'outside-brazil']);
  assert.deepEqual(CONFIG.polls.age.options.map(option => option.id), ['under-25', '25-34', '35-44', '45-54', '55-plus']);
  for (const key of ['exam-1', 'exam-2']) {
    assert.equal(CONFIG.polls[key].correct, 'neoplasia');
    assert.deepEqual(CONFIG.polls[key].options.map(option => option.id), ['neoplasia', 'trauma', 'infection', 'autoimmune']);
  }
});

test('the template provides the presenter, citation, features, boards and library exams', () => {
  assert.equal(CONFIG.presenter.name, 'Thales Matheus M. Santos');
  assert.equal(CONFIG.presenter.role, 'Radiologist · developer');
  assert.deepEqual(CONFIG.presenter.contact, {
    email: 'thalesmmsradio@gmail.com',
    linkedin: 'https://www.linkedin.com/in/thales-matheus-m-santos-974314287',
    github: 'https://github.com/ThalesMMS'
  });
  assert.equal(CONFIG.citation.url, 'https://github.com/ThalesMMS/web-presentation-template');
  assert.equal(CONFIG.citation.text, `Santos, T. M. M. (2026). Interactive presentation template [Computer software]. ${CONFIG.citation.url}`);
  assert.deepEqual(CONFIG.features, {
    canvas: { enabled: true, url: 'http://192.168.0.10:8086/', label: 'Canvas' }, points: { enabled: false }
  });
  assert.deepEqual(CONFIG.boards, {
    region: { title: 'Messages', moderation: 'auto' },
    'exam-1': { title: 'Discussion', moderation: 'auto' },
    'exam-2': { title: 'Discussion', moderation: 'manual' }
  });
  assert.deepEqual(CONFIG.exams, {
    'abdomen-ct': { title: 'Abdominal CT', studyId: 'visible-human-abdomen-ct', src: '/dicom-slide/exams/library/visible-human-abdomen-ct/study.js' },
    'brain-mr': { title: 'Brain MR', studyId: 'mri-dir-t1-mr', src: '/dicom-slide/exams/library/mri-dir-t1-mr/study.js' }
  });
});

test('slideById returns configured slides and null for unknown IDs', () => {
  assert.equal(slideById(CONFIG, 'exam-1'), CONFIG.slides[4]);
  assert.equal(slideById(CONFIG, 'unknown'), null);
  assert.equal(slideById(CONFIG, 4), null);
  assert.equal(slideById({}, 'cover'), null);
});

test('audienceForSlide derives poll, exam, board, questions and contact defaults', () => {
  assert.deepEqual(audienceForSlide({ type: 'cover' }, CONFIG), {
    poll: null, board: null, exam: null, questions: true, contact: false
  });
  assert.deepEqual(audienceForSlide(slideById(CONFIG, 'exam-1'), CONFIG), {
    poll: 'exam-1', board: 'exam-1', exam: 'abdomen-ct', questions: false, contact: false
  });
  assert.equal(audienceForSlide(slideById(CONFIG, 'poll-secret'), CONFIG).poll, 'age');
  assert.equal(audienceForSlide(slideById(CONFIG, 'poll-results'), CONFIG).poll, null);
  assert.deepEqual(audienceForSlide(slideById(CONFIG, 'closing'), CONFIG), {
    poll: null, board: null, exam: null, questions: true, contact: true
  });
});

test('audienceForSlide respects explicit audiencePoll, audienceExam and questions overrides', () => {
  const slide = { type: 'content', poll: 'age', pollResults: 'final', exam: 'brain-mr', board: 'exam-2', audiencePoll: 'exam-1', audienceExam: 'abdomen-ct', questions: true };
  const before = structuredClone(slide);
  assert.deepEqual(audienceForSlide(slide, CONFIG), {
    poll: 'exam-1', board: 'exam-2', exam: 'abdomen-ct', questions: true, contact: false
  });
  assert.deepEqual(slide, before);
  assert.deepEqual(audienceForSlide({ ...slide, audiencePoll: null, audienceExam: null, questions: false }, CONFIG), {
    poll: null, board: 'exam-2', exam: null, questions: false, contact: false
  });
  assert.equal(audienceForSlide({ type: 'closing', contact: false }, CONFIG).contact, true);
  const continued = slideById(CONFIG, 'exam-1-continued');
  assert.equal(continued.poll, undefined);
  assert.equal(continued.exam, undefined);
  assert.deepEqual(continued.items, [
    'Slides can advance while the exam stays open on every phone',
    'Votes keep counting until the poll is closed',
    'Use the control room to moderate the discussion'
  ]);
  assert.deepEqual(audienceForSlide(continued, CONFIG), {
    poll: 'exam-1', board: null, exam: 'abdomen-ct', questions: false, contact: false
  });
});

test('scoredPollKeys counts only polls with a declared correct answer', () => {
  assert.deepEqual(scoredPollKeys(CONFIG), ['exam-1', 'exam-2']);
  assert.deepEqual(scoredPollKeys({}), []);
  assert.deepEqual(scoredPollKeys({ polls: { first: {}, second: { correct: 'yes' } } }), ['second']);
});

test('paceSchedule allocates remaining minutes equally to undeclared non-cover slides', () => {
  assert.deepEqual(paceSchedule(CONFIG), {
    total: 30,
    expected: {
      cover: 0, 'poll-live': 0, 'poll-secret': 5, 'poll-results': 8, 'exam-1': 9.5,
      'exam-1-continued': 17.5, pause: 19, 'exam-2': 20.5, 'exam-2-results': 26.5, closing: 28
    }
  });
});

test('paceSchedule honors zero declarations and never allocates negative remaining time', () => {
  const slides = [{ id: 'cover', type: 'cover' }, { id: 'first', type: 'content' }, { id: 'second', type: 'content' }, { id: 'last', type: 'closing' }];
  assert.deepEqual(paceSchedule({ slides, timing: { totalMinutes: 6, slides: { first: 0 } } }), {
    total: 6, expected: { cover: 0, first: 0, second: 0, last: 3 }
  });
  assert.deepEqual(paceSchedule({ slides, timing: { totalMinutes: 5, slides: { first: 8, last: 2 } } }), {
    total: 5, expected: { cover: 0, first: 0, second: 8, last: 8 }
  });
  assert.deepEqual(paceSchedule({ slides, timing: { totalMinutes: 10, slides: { cover: 1, first: 2, second: 3, last: 4 } } }), {
    total: 10, expected: { cover: 0, first: 1, second: 3, last: 6 }
  });
  assert.deepEqual(paceSchedule({}), { total: 0, expected: {} });
});
