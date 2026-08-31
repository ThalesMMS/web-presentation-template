export function activityForSlide(slide) {
  if (slide.type === 'cover') return 'opening';
  if (slide.type === 'poll') return `poll:${slide.poll}`;
  if (slide.type === 'closing') return 'closing';
  return 'stage';
}
