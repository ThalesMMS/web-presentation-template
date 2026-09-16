import { SETTING_GROUPS, getSetting, setSetting, settingsFromConfig, slideTextFields } from './settings.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

function fieldMarkup(field, name = field.path) {
  const id = `setting-${name.replaceAll('.', '-')}`;
  const type = field.type || 'text';
  const attributes = `id="${escapeHtml(id)}" name="${escapeHtml(name)}" ${field.required ? 'required' : ''}
    ${field.maxLength ? `maxlength="${field.maxLength}"` : ''}`;
  const input = type === 'textarea'
    ? `<textarea ${attributes} rows="3"></textarea>`
    : `<input ${attributes} type="${type}" ${type === 'number' ? `min="${field.min}" max="${field.max}" step="any"` : ''}>`;
  return `<label class="settings-field${type === 'color' ? ' settings-color' : type === 'checkbox' ? ' settings-check' : ''}" for="${escapeHtml(id)}">
    <span>${escapeHtml(field.label)}</span>${input}</label>`;
}

export function mountSettings(initialConfig, onSaved) {
  const form = document.getElementById('settingsForm');
  const fields = document.getElementById('settingsFields');
  const feedback = document.getElementById('settingsFeedback');
  const save = document.getElementById('saveSettings');
  const discard = document.getElementById('discardSettings');
  const defaults = document.getElementById('defaultSettings');
  let savedConfig = initialConfig;
  let revision = initialConfig.settingsRevision || 0;
  let dirty = false;
  let busy = '';
  let authorized = false;
  let lastTitle = initialConfig.title;

  fields.innerHTML = SETTING_GROUPS.map(group => `<section class="panel settings-group">
    <h3>${escapeHtml(group.title)}</h3><div class="settings-fields">${group.fields.map(field => fieldMarkup(field)).join('')}</div>
    ${group.title === 'Timing' ? '<p class="regie-meta">Leave a slide duration empty to share the remaining time automatically. Cover slides default to zero.</p>' : ''}
  </section>`).join('') + `<section class="panel settings-group settings-slides"><h3>Slide text and timing</h3>
    <p class="muted">Edit slide headings and content. List fields use one item per line.</p>
    ${initialConfig.slides.map((slide, index) => `<details class="settings-slide"><summary>${index + 1}. <span data-slide-label="${escapeHtml(slide.id)}">${escapeHtml(slide.title || slide.id)}</span></summary>
      <div class="settings-fields">${fieldMarkup({ label: 'Duration in minutes, empty for automatic', type: 'number', min: 0, max: 1440 }, `timing.slides.${slide.id}`)}
      ${slideTextFields(slide).map(key => fieldMarkup({
        label: { title: 'Slide title', eyebrow: 'Heading label', description: 'Description', explanation: 'Explanation', topics: 'Topics, one per line', items: 'List items, one per line' }[key],
        type: ['title', 'eyebrow'].includes(key) ? 'text' : 'textarea',
        maxLength: ['title', 'eyebrow'].includes(key) ? 200 : ['topics', 'items'].includes(key) ? 15030 : 2000
      }, `slides.${slide.id}.${key}`)).join('')}</div></details>`).join('')}
    </section>`;

  function message(text, error = false) {
    feedback.textContent = text;
    feedback.classList.toggle('is-error', error);
  }

  function updateButtons() {
    const disabled = !authorized || Boolean(busy);
    fields.disabled = disabled;
    save.disabled = disabled || !dirty;
    discard.disabled = disabled || !dirty;
    defaults.disabled = disabled;
    save.textContent = busy === 'save' ? 'Saving…' : 'Save settings';
    defaults.textContent = busy === 'defaults' ? 'Loading defaults…' : 'Restore defaults';
    form.setAttribute('aria-busy', String(Boolean(busy)));
  }

  function fill(settings) {
    for (const { fields: group } of SETTING_GROUPS) {
      for (const field of group) {
        const input = form.elements.namedItem(field.path);
        if (field.type === 'checkbox') input.checked = getSetting(settings, field.path);
        else input.value = getSetting(settings, field.path);
      }
    }
    for (const slide of initialConfig.slides) {
      form.elements.namedItem(`timing.slides.${slide.id}`).value = settings.timing.slides[slide.id] ?? '';
      for (const key of slideTextFields(slide)) {
        const value = settings.slides[slide.id][key];
        form.elements.namedItem(`slides.${slide.id}.${key}`).value = Array.isArray(value) ? value.join('\n') : value;
      }
    }
    for (const label of form.querySelectorAll('[data-slide-label]')) {
      const id = label.dataset.slideLabel;
      label.textContent = settings.slides[id].title || id;
    }
    lastTitle = settings.title;
    form.elements.namedItem('features.canvas.url').required = settings.features.canvas.enabled;
  }

  function read() {
    const settings = { slides: {} };
    for (const { fields: group } of SETTING_GROUPS) {
      for (const field of group) {
        const input = form.elements.namedItem(field.path);
        setSetting(settings, field.path, field.type === 'checkbox' ? input.checked : field.type === 'number' ? input.valueAsNumber : input.value);
      }
    }
    settings.timing.slides = {};
    for (const slide of initialConfig.slides) {
      const timing = form.elements.namedItem(`timing.slides.${slide.id}`);
      if (timing.value !== '') settings.timing.slides[slide.id] = timing.valueAsNumber;
      settings.slides[slide.id] = Object.fromEntries(slideTextFields(slide).map(key => {
        const value = form.elements.namedItem(`slides.${slide.id}.${key}`).value;
        return [key, ['items', 'topics'].includes(key) ? value.split('\n').map(line => line.trim()).filter(Boolean) : value];
      }));
    }
    return settings;
  }

  form.addEventListener('input', event => {
    if (event.target.name === 'title') {
      for (const slide of initialConfig.slides.filter(slide => slide.type === 'cover')) {
        const title = form.elements.namedItem(`slides.${slide.id}.title`);
        if (title.value === lastTitle) title.value = event.target.value;
      }
      lastTitle = event.target.value;
    }
    form.elements.namedItem('features.canvas.url').required = form.elements.namedItem('features.canvas.enabled').checked;
    dirty = true;
    message('Unsaved changes.');
    updateButtons();
  });

  form.addEventListener('invalid', event => {
    const details = event.target.closest('details');
    if (details) details.open = true;
  }, true);

  async function request(options) {
    const response = await fetch('/api/settings', { credentials: 'same-origin', ...options });
    if (response.status === 404) throw new Error('Your control session expired. Reopen the control room with the presenter key.');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save settings.');
    return result;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!authorized || busy || !dirty || !form.reportValidity()) return;
    const settings = read();
    busy = 'save';
    message('Saving settings…');
    updateButtons();
    try {
      const { config } = await request({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, settings }) });
      savedConfig = config;
      revision = config.settingsRevision;
      dirty = false;
      fill(settingsFromConfig(config));
      onSaved(config);
      message('Settings saved. The presentation and audience are up to date.');
    } catch (error) {
      message(error.message || 'Could not save settings. Your edits are still here.', true);
    } finally {
      busy = '';
      updateButtons();
    }
  });

  discard.addEventListener('click', () => {
    revision = savedConfig.settingsRevision;
    fill(settingsFromConfig(savedConfig));
    dirty = false;
    message('Changes discarded.');
    updateButtons();
  });

  defaults.addEventListener('click', async () => {
    if (!authorized || busy) return;
    busy = 'defaults';
    message('Loading template defaults…');
    updateButtons();
    try {
      const result = await request();
      savedConfig = result.config;
      revision = savedConfig.settingsRevision;
      fill(result.defaults);
      dirty = true;
      message('Template defaults loaded. Save settings to apply them.');
    } catch (error) {
      message(error.message || 'Could not load defaults.', true);
    } finally {
      busy = '';
      updateButtons();
    }
  });

  fill(settingsFromConfig(initialConfig));
  updateButtons();
  return {
    authorize(value) { authorized = value; updateButtons(); },
    update(config) {
      if (config.settingsRevision <= savedConfig.settingsRevision) return;
      savedConfig = config;
      if (dirty) {
        if (!busy) message('Settings changed in another control room. Discard your changes to load the latest settings.', true);
      } else {
        revision = config.settingsRevision;
        fill(settingsFromConfig(config));
      }
    }
  };
}
