export const SETTING_GROUPS = [
  { title: 'Presentation', fields: [
    { path: 'title', label: 'Presentation title', required: true, maxLength: 200 },
    { path: 'subtitle', label: 'Subtitle', type: 'textarea', maxLength: 1000 },
    { path: 'citation.text', label: 'Citation', type: 'textarea', maxLength: 2000 },
    { path: 'citation.url', label: 'Citation link', type: 'url', maxLength: 2048 }
  ] },
  { title: 'Presenter', fields: [
    { path: 'presenter.name', label: 'Presenter name', maxLength: 200 },
    { path: 'presenter.role', label: 'Role', maxLength: 200 },
    { path: 'presenter.contact.email', label: 'Contact email', type: 'email', maxLength: 254 },
    { path: 'presenter.contact.linkedin', label: 'LinkedIn URL', type: 'url', maxLength: 2048 },
    { path: 'presenter.contact.github', label: 'GitHub URL', type: 'url', maxLength: 2048 }
  ] },
  { title: 'Appearance', fields: [
    { path: 'brand.name', label: 'Brand name', maxLength: 200 },
    ...Object.entries({ background: 'Background', surface: 'Panels', text: 'Text', muted: 'Secondary text', accent: 'Accent', accentStrong: 'Strong accent' })
      .map(([key, label]) => ({ path: `brand.colors.${key}`, label, type: 'color' }))
  ] },
  { title: 'Canvas', fields: [
    { path: 'features.canvas.enabled', label: 'Show Canvas in the presentation', type: 'checkbox' },
    { path: 'features.canvas.label', label: 'Canvas button label', required: true, maxLength: 60 },
    { path: 'features.canvas.url', label: 'Canvas URL', type: 'url', maxLength: 2048 }
  ] },
  { title: 'Timing', fields: [
    { path: 'timing.totalMinutes', label: 'Total duration in minutes', type: 'number', required: true, min: 1, max: 1440 }
  ] }
];

const COLOR_DEFAULTS = {
  background: '#0b1220', surface: '#111c30', text: '#f6f8fc',
  muted: '#b7c2d8', accent: '#74d4b3', accentStrong: '#31b98a'
};

export function getSetting(value, path) {
  return path.split('.').reduce((entry, key) => entry?.[key], value);
}

export function setSetting(value, path, next) {
  const keys = path.split('.');
  const last = keys.pop();
  const parent = keys.reduce((entry, key) => (entry[key] ??= {}), value);
  parent[last] = next;
}

export function slideTextFields(slide) {
  return ['title', 'eyebrow', 'description', 'explanation', 'topics', 'items'].filter(key =>
    key === 'title' || key === 'eyebrow' || Object.hasOwn(slide, key)
    || (key === 'description' && ['cover', 'pause', 'closing'].includes(slide.type)));
}

export function settingsFromConfig(config) {
  const settings = {};
  for (const { fields } of SETTING_GROUPS) {
    for (const field of fields) {
      const fallback = field.type === 'checkbox' ? false : field.type === 'color'
        ? COLOR_DEFAULTS[field.path.split('.').at(-1)] : field.path === 'features.canvas.label'
          ? 'Canvas' : field.type === 'number' ? 30 : '';
      setSetting(settings, field.path, getSetting(config, field.path) ?? fallback);
    }
  }
  settings.timing.slides = { ...config.timing?.slides };
  settings.slides = Object.fromEntries(config.slides.map(slide => [slide.id,
    Object.fromEntries(slideTextFields(slide).map(key => [key,
      ['items', 'topics'].includes(key) ? [...(slide[key] || [])] : slide[key] ?? ''
    ]))
  ]));
  return settings;
}

function textValue(value, label, limit, required = false) {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be text of at most ${limit} characters.`);
  }
  const result = value.trim();
  if (required && !result) throw new Error(`${label} is required.`);
  return result;
}

function minutesValue(value, label, min) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > 1440) {
    throw new Error(`${label} must be between ${min} and 1440 minutes.`);
  }
  return value;
}

export function validateSettings(input, config) {
  const settings = {};
  for (const { fields } of SETTING_GROUPS) {
    for (const field of fields) {
      let value = getSetting(input, field.path);
      if (field.type === 'checkbox') {
        if (typeof value !== 'boolean') throw new Error(`${field.label} must be on or off.`);
      } else if (field.type === 'number') {
        value = minutesValue(value, field.label, field.min);
      } else {
        value = textValue(value, field.label, field.maxLength || 7, field.required);
        if (field.type === 'color' && !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${field.label} must be a six-digit hex color.`);
        if (field.type === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('Enter a valid contact email.');
        if (field.type === 'url' && value) {
          let url;
          try { url = new URL(value); } catch { /* Report the field below. */ }
          if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
            throw new Error(`${field.label} must be an HTTP or HTTPS URL without credentials.`);
          }
        }
      }
      setSetting(settings, field.path, value);
    }
  }
  if (settings.features.canvas.enabled && !settings.features.canvas.url) throw new Error('Enter a Canvas URL or turn Canvas off.');
  settings.timing.slides = {};
  settings.slides = {};
  for (const slide of config.slides) {
    const timing = input?.timing?.slides?.[slide.id];
    if (timing !== undefined) settings.timing.slides[slide.id] = minutesValue(timing, slide.title || slide.id, 0);
    const fields = {};
    for (const key of slideTextFields(slide)) {
      const value = input?.slides?.[slide.id]?.[key];
      if (['topics', 'items'].includes(key)) {
        if (!Array.isArray(value) || value.length > 30) throw new Error(`${slide.id} allows up to 30 list items.`);
        fields[key] = value.map(item => textValue(item, `${slide.id} ${key}`, 500, true));
      } else {
        fields[key] = textValue(value, `${slide.id} ${key}`, ['title', 'eyebrow'].includes(key) ? 200 : 2000);
      }
    }
    settings.slides[slide.id] = fields;
  }
  return settings;
}

export function applySettings(config, stored) {
  if (!stored?.settings) return { ...config, settingsRevision: stored?.revision || 0 };
  const settings = stored.settings;
  return {
    ...config, title: settings.title, subtitle: settings.subtitle,
    presenter: settings.presenter, citation: settings.citation, brand: settings.brand,
    features: { ...config.features, canvas: settings.features.canvas }, timing: settings.timing,
    slides: config.slides.map(slide => ({ ...slide, ...settings.slides[slide.id] })),
    settingsRevision: stored.revision
  };
}

export function applyBrand(config) {
  const tokens = { background: '--color-bg', surface: '--color-surface', text: '--color-text',
    muted: '--color-text-muted', accent: '--color-accent', accentStrong: '--color-accent-strong' };
  for (const [key, token] of Object.entries(tokens)) {
    if (config.brand?.colors?.[key]) document.documentElement.style.setProperty(token, config.brand.colors[key]);
  }
}
