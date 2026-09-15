export function slideById(config, id) {
  return (config.slides || []).find(slide => slide.id === id) || null;
}

export function audienceForSlide(slide, config) {
  return {
    poll: slide.audiencePoll !== undefined
      ? slide.audiencePoll
      : (slide.poll && slide.pollResults !== 'final' ? slide.poll : null),
    board: slide.audienceBoard !== undefined ? slide.audienceBoard : (slide.board || null),
    exam: slide.audienceExam === undefined ? (slide.exam || null) : slide.audienceExam,
    questions: slide.questions ?? !slide.board,
    contact: slide.type === 'closing'
  };
}

export function scoredPollKeys(config) {
  return Object.keys(config.polls || {}).filter(key => config.polls[key].correct !== undefined);
}

export function paceSchedule(config) {
  const slides = config.slides || [];
  const total = config.timing?.totalMinutes ?? 0;
  const declared = config.timing?.slides || {};
  const declaredMinutes = slides.reduce((sum, slide) => sum + (declared[slide.id] ?? 0), 0);
  const sharedSlides = slides.filter(slide => slide.type !== 'cover' && declared[slide.id] === undefined);
  const sharedMinutes = sharedSlides.length ? Math.max(0, total - declaredMinutes) / sharedSlides.length : 0;
  const expected = {};
  let elapsed = 0;
  for (const slide of slides) {
    expected[slide.id] = elapsed;
    elapsed += declared[slide.id] ?? (slide.type === 'cover' ? 0 : sharedMinutes);
  }
  return { total, expected };
}
