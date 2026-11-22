<!-- Service Dark Settings: a schema-driven settings page with categories on the left and settings on the right. A category can be a custom page the app draws, still saved through Settings. -->
<script lang="ts" module>
  import type { SettingField } from '../lib/settings.js';

  /** What a custom page gets: its settings, their values and errors, and set() to change one. */
  export interface SettingsPage {
    category: string;
    /** Each setting described from the schema: key, title, description, kind, default and so on. */
    settings: SettingField[];
    /** Current values by key, including changes still waiting for Save. */
    values: Record<string, any>;
    /** Errors by key: a schema message, or the sentence a save resolved to. */
    errors: Record<string, string>;
    /**
     * Change one setting the way a built-in control does: it is parsed with its schema, then saved on
     * change or held for Save, by the category's .meta(). Resolves to the error, or to nothing once saved
     * (or once held for Save), so a dialog can await it.
     */
    set: (key: string, value: unknown) => Promise<string | void>;
    /** True while a change to this setting is being saved, past the spinner delay. */
    saving: (key: string) => boolean;
  }

</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ZodObject } from 'zod';
  import Icon from './Icon.svelte';
  import Switch from './Switch.svelte';
  import IconButton from './IconButton.svelte';
  import TokenField from './TokenField.svelte';
  import SaveBar from './SaveBar.svelte';
  import { copy } from '../actions/copy.js';
  import { describeSettings, settingSchema, isModified } from '../lib/settings.js';
  import { Latest, timing, nextSeq } from '../lib/pending.svelte.js';

  /** Each category holds an object of settings. */
  type Values = Record<string, any>;

  interface Change {
    /** "category.key", the same id shown under each setting. */
    path: string;
    value: unknown;
    /** All settings after the change. */
    settings: Values;
    /** Grows with every change, across page loads. Store the highest per path and ignore an older one. */
    seq: number;
    /** Pass to fetch. */
    signal: AbortSignal;
    /** Idempotency key: the same key means the same change. */
    key: string;
  }

  interface Save {
    /** The category whose Save was clicked. */
    category: string;
    /** Its unsaved changes, by setting key, each already parsed with its schema. */
    changes: Record<string, unknown>;
    /** All settings as they will be once saved. */
    settings: Values;
  }

  interface Props {
    /** A z.object of categories, each a z.object of settings, described with .meta(). */
    schema: ZodObject;
    /** Current settings, already parsed with the schema. Bindable. */
    value: Values;
    /** Id of the open category. Bindable, so it can live in the URL. */
    category?: string;
    /** Accessible name for the page. */
    label?: string;
    /**
     * Called after each valid change, once typing pauses or the field loses focus. Return the promise:
     * the setting shows a spinner, changes to it are sent one at a time with only the latest kept, and a
     * sentence it resolves to puts the saved value back and shows the sentence under the setting.
     */
    onchange?: (change: Change) => unknown;
    /** Called when Save is clicked in a category whose changes wait for it. Resolve to save them; return a sentence to show
     * as the error and keep them unsaved. */
    onsave?: (save: Save) => Promise<string | void> | string | void;
    /**
     * Custom pages, by category id: the app draws the category however it likes, and reads and writes its
     * settings through the page it is given, so validation, saving, Save and errors work as on any other.
     */
    pages?: Record<string, Snippet<[SettingsPage]>>;
  }

  let { schema, value = $bindable(), category = $bindable(), label = 'Settings', onchange, onsave, pages = {} }: Props = $props();

  const uid = $props.id();
  const categories = $derived(describeSettings(schema));
  const current = $derived(category ?? categories[0]?.id);
  const openCat = $derived(categories.find((c) => c.id === current));

  let query = $state('');
  let errors = $state<Record<string, string>>({});
  let drafts = $state<Record<string, string>>({});
  /** Valid changes waiting for a Save, by category, then key. */
  let pending = $state<Values>({});
  /** Secrets whose new value is being typed. */
  let editing = $state<Record<string, boolean>>({});
  /** Secrets shown in clear while being typed. */
  let revealed = $state<Record<string, boolean>>({});
  let saveErrors = $state<Record<string, string>>({});

  // Saving on change: one queue per setting, so the last value typed is the last one written.
  let queues = $state<Record<string, Latest>>({});
  /** The value the server last accepted, to put back if a change fails. */
  const accepted: Record<string, unknown> = {};
  const timers: Record<string, ReturnType<typeof setTimeout>> = {};
  const waiting: Record<string, () => void> = {};
  /** Custom pages awaiting a save of a setting, resolved when it settles. */
  const waiters: Record<string, ((error?: string) => void)[]> = {};

  const q = $derived(query.trim().toLowerCase());
  const sections = $derived(
    q
      ? categories
          .map((c) => (pages[c.id] ? c : { ...c, settings: c.settings.filter((s) => `${c.title} ${s.title} ${s.description ?? ''} ${s.id}`.toLowerCase().includes(q)) }))
          .filter((c) => (pages[c.id] ? pageMatches(c) : c.settings.length))
      : categories.filter((c) => c.id === current)
  );

  type Setting = (typeof categories)[number]['settings'][number];

  const fieldId = (s: Setting) => `sd-set-${uid}-${s.id.replace('.', '-')}`;
  const waitsForSave = (id: string) => categories.find((c) => c.id === id)?.saveButton === true;
  const isPending = (s: Setting) => pending[s.category] != null && s.key in pending[s.category];
  const get = (s: Setting) => (isPending(s) ? pending[s.category][s.key] : (value?.[s.category]?.[s.key] ?? s.default));
  /** Changes waiting for Save, counting one still being fixed so the bar never says there are none while you type. */
  const unsaved = (id: string) => new Set([...Object.keys(pending[id] ?? {}), ...Object.keys(errors).filter((e) => e.startsWith(`${id}.`)).map((e) => e.slice(id.length + 1))]).size;
  const invalid = (id: string) => Object.keys(errors).some((e) => e.startsWith(`${id}.`));

  /** later: the change was typed, so it is sent once typing pauses. */
  function commit(s: Setting, raw: unknown, later = false) {
    const result = settingSchema(schema, s.category, s.key).safeParse(raw);
    if (!result.success) {
      errors[s.id] = result.error.issues[0].message;
      clearTimeout(timers[s.id]);
      delete waiting[s.id];
      return;
    }
    delete errors[s.id];
    if (waitsForSave(s.category)) {
      delete drafts[s.id];
      const saved = value?.[s.category]?.[s.key] ?? s.default;
      const rest = { ...pending[s.category] };
      if (JSON.stringify(result.data) === JSON.stringify(saved)) delete rest[s.key];
      else rest[s.key] = result.data;
      pending = { ...pending, [s.category]: rest };
      delete saveErrors[s.category];
      return;
    }
    if (later) {
      clearTimeout(timers[s.id]);
      waiting[s.id] = () => send(s, result.data);
      timers[s.id] = setTimeout(() => flush(s), timing.debounce);
    } else {
      delete drafts[s.id];
      send(s, result.data);
    }
  }

  /** Send a typed change now instead of after the pause, such as on blur. */
  function flush(s: Setting) {
    clearTimeout(timers[s.id]);
    const go = waiting[s.id];
    delete waiting[s.id];
    go?.();
  }

  function send(s: Setting, data: unknown) {
    if (!(s.id in accepted)) accepted[s.id] = value?.[s.category]?.[s.key] ?? s.default;
    delete drafts[s.id];
    const settings = { ...value, [s.category]: { ...value?.[s.category], [s.key]: data } };
    value = settings;
    queues[s.id] ??= new Latest((r) => settle(s, r), `Settings onchange for ${s.id}`);
    queues[s.id].send((w) => onchange?.({ path: s.id, value: data, settings, ...w }));
  }

  function settle(s: Setting, r: { ok: boolean; error?: string }) {
    const now = value?.[s.category]?.[s.key];
    for (const done of waiters[s.id]?.splice(0) ?? []) done(r.error);
    if (r.ok) {
      accepted[s.id] = now;
      return;
    }
    if (!r.error) return;
    // Keep what was typed in the field, but put the accepted value back in the settings.
    if (s.kind === 'text' || s.kind === 'number' || s.kind === 'list') drafts[s.id] = Array.isArray(now) ? now.join('\n') : now == null ? '' : String(now);
    value = { ...value, [s.category]: { ...value?.[s.category], [s.key]: accepted[s.id] } };
    errors[s.id] = r.error;
  }

  /** A switch that flips only once saved (wait in .meta()). */
  async function saveNow(s: Setting, raw: boolean, w: { signal: AbortSignal; key: string }) {
    const result = settingSchema(schema, s.category, s.key).safeParse(raw);
    if (!result.success) return result.error.issues[0].message;
    const settings = { ...value, [s.category]: { ...value?.[s.category], [s.key]: result.data } };
    const error = await onchange?.({ path: s.id, value: result.data, settings, seq: nextSeq(), ...w });
    if (typeof error === 'string' && error) {
      errors[s.id] = error;
      return error;
    }
    delete errors[s.id];
    value = settings;
  }

  function discard(id: string) {
    pending = { ...pending, [id]: {} };
    for (const key of Object.keys(errors)) if (key.startsWith(`${id}.`)) delete errors[key];
    for (const key of Object.keys(drafts)) if (key.startsWith(`${id}.`)) delete drafts[key];
    for (const key of Object.keys(editing)) if (key.startsWith(`${id}.`)) delete editing[key];
    for (const key of Object.keys(revealed)) if (key.startsWith(`${id}.`)) delete revealed[key];
    delete saveErrors[id];
  }

  /** The SaveBar waits on this, so it blocks and spins while onsave runs. */
  async function save(id: string) {
    const changes = { ...pending[id] };
    const settings = { ...value, [id]: { ...value?.[id], ...changes } };
    const error = await onsave?.({ category: id, changes, settings });
    if (typeof error === 'string' && error) {
      saveErrors[id] = error;
      return;
    }
    value = settings;
    discard(id);
  }

  function cancelSecret(s: Setting) {
    delete editing[s.id];
    delete revealed[s.id];
    delete errors[s.id];
    const rest = { ...pending[s.category] };
    delete rest[s.key];
    pending = { ...pending, [s.category]: rest };
  }

  function typed(s: Setting, text: string) {
    drafts[s.id] = text;
    if (s.kind === 'number') commit(s, text.trim() === '' ? undefined : Number(text), true);
    else if (s.kind === 'list') commit(s, text.split('\n').map((l) => l.trim()).filter(Boolean), true);
    else commit(s, text, true);
  }

  function shown(s: Setting) {
    if (drafts[s.id] != null) return drafts[s.id];
    const v = get(s);
    return Array.isArray(v) ? v.join('\n') : v == null ? '' : String(v);
  }

  function open(id: string) {
    category = id;
    query = '';
  }

  // ---- Custom pages ----------------------------------------------------------------------

  function setFromPage(c: Category, key: string, raw: unknown): Promise<string | void> {
    const s = c.settings.find((x) => x.key === key);
    if (!s) return Promise.resolve(`No setting named ${key} in ${c.id}.`);
    commit(s, raw);
    if (errors[s.id]) return Promise.resolve(errors[s.id]);
    if (waitsForSave(c.id)) return Promise.resolve();
    return new Promise((resolve) => (waiters[s.id] ??= []).push(resolve));
  }

  /** Built fresh for each render; its getters read live state, so the page updates as values change. */
  function pageFor(c: Category): SettingsPage {
    return {
      category: c.id,
      settings: c.settings,
      get values() {
        return Object.fromEntries(c.settings.map((s) => [s.key, get(s)]));
      },
      get errors() {
        return Object.fromEntries(c.settings.filter((s) => errors[s.id]).map((s) => [s.key, errors[s.id]]));
      },
      set: (key, raw) => setFromPage(c, key, raw),
      saving: (key) => queues[`${c.id}.${key}`]?.pending.spinning === true
    };
  }

  type Category = (typeof categories)[number];
  const pageMatches = (c: Category) => `${c.title} ${c.description ?? ''} ${c.settings.map((s) => `${s.title} ${s.description ?? ''}`).join(' ')}`.toLowerCase().includes(q);
</script>

<div class="sd-settings" role="region" aria-label={label}>
<div class="sd-settings-layout">
  <nav class="sd-settings-nav" aria-label="{label} categories">
    {#each categories as c (c.id)}
      <button type="button" class="sd-settings-cat" aria-current={!q && c.id === current ? 'true' : undefined} onclick={() => open(c.id)}>
        {#if c.icon}<Icon name={c.icon} />{/if}
        <span class="sd-nav-label">{c.title}</span>
      </button>
    {/each}
  </nav>

  <div class="sd-settings-main">
    <!-- Stays put while the settings scroll, so a category's Save is always in the same place. -->
    <div class="sd-settings-top">
      <div class="sd-settings-search">
        <Icon name="search" />
        <input class="sd-input" type="search" placeholder="Search settings" aria-label="Search settings" bind:value={query} />
      </div>
      {#if !q && openCat}
        <header class="sd-settings-head">
          <div class="sd-settings-titles">
            <h2 class="sd-settings-title" id="sd-set-{uid}-{openCat.id}">{openCat.title}</h2>
            {#if openCat.description}<p class="sd-settings-sub">{openCat.description}</p>{/if}
          </div>
          {#if openCat.saveButton}
            <SaveBar persistent changes={unsaved(openCat.id)} error={saveErrors[openCat.id]} valid={!invalid(openCat.id)} onsave={() => save(openCat.id)} ondiscard={() => discard(openCat.id)} />
          {/if}
        </header>
      {/if}
    </div>

    <div class="sd-settings-body">
    {#each sections as c (c.id)}
      <section class="sd-settings-section" aria-labelledby="sd-set-{uid}-{c.id}">
        {#if q}
          <header class="sd-settings-head">
            <h2 class="sd-settings-title" id="sd-set-{uid}-{c.id}">{c.title}</h2>
          </header>
        {/if}

        {#if pages[c.id] && q}
          <button type="button" class="sd-settings-open" onclick={() => open(c.id)}>Open {c.title}<Icon name="chevron-right" /></button>
        {:else if pages[c.id]}
          <div class="sd-settings-page">{@render pages[c.id](pageFor(c))}</div>
        {:else}
        {#each c.settings as s (s.id)}
          {@const id = fieldId(s)}
          {@const modified = !s.readOnly && s.kind !== 'secret' && isModified(s, get(s))}
          <div class={['sd-setting', modified && 'sd-setting-modified', isPending(s) && 'sd-setting-unsaved']} aria-busy={queues[s.id]?.pending.spinning ? 'true' : undefined}>
            <div class="sd-setting-text">
              <div class="sd-setting-labelrow">
                {#if s.kind === 'boolean' || s.readOnly || (s.kind === 'secret' && !editing[s.id])}
                  <span class="sd-setting-label" id="{id}-label">{s.title}</span>
                {:else}
                  <label class="sd-setting-label" for={id}>{s.title}</label>
                {/if}
                {#if queues[s.id]?.pending.spinning}<span class="sd-spinner sd-setting-spinner" aria-hidden="true"></span>{/if}
                {#if modified && !isPending(s)}
                  <button type="button" class="sd-iconbtn" aria-label="Reset {s.title} to default" title="Reset to default" onclick={() => commit(s, s.default)}><Icon name="rotate-ccw" /></button>
                {/if}
              </div>
              {#if s.description}<p class="sd-setting-desc" id="{id}-desc">{s.description}</p>{/if}
              <code class="sd-setting-id">{s.id}</code>
            </div>

            <div class="sd-setting-control">
              {#if s.kind === 'secret' && !editing[s.id]}
                <div class="sd-setting-secret" role="group" aria-labelledby="{id}-label">
                  {#snippet edit()}<IconButton icon="pencil" label="Edit {s.title}" onclick={() => (editing[s.id] = true)} />{/snippet}
                  {#if value?.[s.category]?.[s.key]}
                    <TokenField value={String(value[s.category][s.key])} masked actions={edit} />
                  {:else}
                    <div class="sd-token"><code class="sd-setting-empty">{s.placeholder ?? 'Not set'}</code>{@render edit()}</div>
                  {/if}
                </div>
              {:else if s.kind === 'secret'}
                <div class="sd-setting-secret">
                  <div class="sd-input-wrap">
                    <!-- svelte-ignore a11y_autofocus -->
                    <input {id} class={['sd-input', 'sd-input-mono', !revealed[s.id] && 'sd-input-masked']} type="text" autocomplete="off" autocapitalize="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" autofocus placeholder="New value" value={drafts[s.id] ?? (isPending(s) ? String(get(s)) : '')} aria-invalid={errors[s.id] ? 'true' : undefined} aria-describedby={errors[s.id] ? `${id}-err` : `${id}-note`} oninput={(e) => typed(s, e.currentTarget.value)} onkeydown={(e) => e.key === 'Escape' && cancelSecret(s)} />
                    <div class="sd-input-actions">
                      <IconButton icon={revealed[s.id] ? 'eye-off' : 'eye'} label={revealed[s.id] ? 'Hide value' : 'Show value'} aria-pressed={revealed[s.id] ? 'true' : 'false'} onclick={() => (revealed[s.id] = !revealed[s.id])} />
                      <IconButton icon="x" label="Keep the saved {s.title}" onclick={() => cancelSecret(s)} />
                    </div>
                  </div>
                </div>
                {#if !errors[s.id]}<div class="sd-field-hint" id="{id}-note">{isPending(s) ? 'Replaces the saved value when you save.' : 'Type or paste the new value.'}</div>{/if}
              {:else if s.kind === 'complex'}
                <p class="sd-field-hint">Needs a custom page: pass one in pages for {s.category}.</p>
              {:else if s.readOnly}
                <div class="sd-setting-readonly" aria-labelledby="{id}-label">
                  <code>{shown(s)}</code>
                  <button type="button" class="sd-iconbtn" aria-label="Copy {s.title}" title="Copy {s.title}" use:copy={{ text: shown(s) }}><Icon name="copy" /></button>
                </div>
              {:else if s.kind === 'boolean'}
                {#if s.wait}
                  <Switch wait checked={get(s) === true} aria-label={s.title} onchange={(v, w) => saveNow(s, v, w)} />
                {:else}
                  <Switch checked={get(s) === true} aria-label={s.title} onchange={(v) => commit(s, v)} />
                {/if}
              {:else if s.kind === 'enum'}
                <div class="sd-select-wrap">
                  <select {id} class={['sd-input', 'sd-select', s.mono && 'sd-input-mono']} value={get(s)} aria-describedby={s.description ? `${id}-desc` : undefined} onchange={(e) => commit(s, e.currentTarget.value)}>
                    {#each s.options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
                  </select>
                  <Icon name="chevron-down" />
                </div>
              {:else if s.kind === 'number'}
                <div class="sd-input-unit">
                  <input {id} class="sd-input" type="number" inputmode="decimal" min={s.min} max={s.max} step={s.step} value={shown(s)} aria-invalid={errors[s.id] ? 'true' : undefined} aria-describedby={errors[s.id] ? `${id}-err` : s.description ? `${id}-desc` : undefined} oninput={(e) => typed(s, e.currentTarget.value)} onblur={() => flush(s)} />
                  {#if s.unit}<span>{s.unit}</span>{/if}
                </div>
              {:else if s.kind === 'list'}
                <textarea {id} class={['sd-input', 'sd-textarea', s.mono && 'sd-input-mono']} rows="3" value={shown(s)} placeholder={s.placeholder} aria-invalid={errors[s.id] ? 'true' : undefined} aria-describedby={errors[s.id] ? `${id}-err` : s.description ? `${id}-desc` : undefined} oninput={(e) => typed(s, e.currentTarget.value)} onblur={() => flush(s)}></textarea>
              {:else}
                <input {id} class={['sd-input', s.mono && 'sd-input-mono']} value={shown(s)} placeholder={s.placeholder} aria-invalid={errors[s.id] ? 'true' : undefined} aria-describedby={errors[s.id] ? `${id}-err` : s.description ? `${id}-desc` : undefined} oninput={(e) => typed(s, e.currentTarget.value)} onblur={() => flush(s)} />
              {/if}
              {#if errors[s.id]}<div class="sd-field-error" id="{id}-err">{errors[s.id]}</div>{/if}
            </div>

          </div>
        {/each}
        {/if}
        {#if q && c.saveButton}
          <SaveBar changes={unsaved(c.id)} error={saveErrors[c.id]} valid={!invalid(c.id)} onsave={() => save(c.id)} ondiscard={() => discard(c.id)} />
        {/if}
      </section>
    {:else}
      <p class="sd-settings-empty" role="status">No settings match “{query}”.</p>
    {/each}
    </div>
  </div>
</div>
</div>
