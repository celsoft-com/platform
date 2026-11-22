<!-- Service Dark CodeInput: one box per character for pairing and one-time codes. Waits on an oncomplete that returns a promise. -->
<script lang="ts">
  import { codeInput } from '../actions/codeInput.js';
  import { busy } from '../actions/busy.js';
  import { Pending, messages } from '../lib/pending.svelte.js';

  type Wait = { signal: AbortSignal; key: string };

  interface Props {
    length?: number;
    /** Show a separator every N boxes. 0 for none. */
    group?: number;
    label?: string;
    hint?: string;
    /** One sentence that says what to do next. Marks every box invalid. */
    error?: string;
    /** The typed code, uppercase. Bindable. */
    value?: string;
    /** Form field name. Adds a hidden input so SvelteKit form actions receive the code. */
    name?: string;
    disabled?: boolean;
    autofocus?: boolean;
    /** 'one-time-code' only for a sign-in code sent to the person; 'off' (default) for pairing codes. */
    autocomplete?: 'off' | 'one-time-code';
    oninput?: (value: string) => void;
    /**
     * Called once every box is filled. Return the promise to check the code: the boxes lock and a spinner
     * shows; resolve to a sentence to unlock them with that error and the first box selected for retyping.
     */
    oncomplete?: (value: string, wait: Wait) => unknown;
  }

  let {
    length = 6,
    group = 3,
    label,
    hint,
    error,
    value = $bindable(''),
    name,
    disabled = false,
    autofocus = false,
    autocomplete = 'off',
    oninput,
    oncomplete
  }: Props = $props();

  const uid = $props.id();
  const labelId = `sd-code-${uid}`;
  const noteId = `sd-code-${uid}-note`;
  const initial = value.toUpperCase().split('');

  const check = new Pending({ name: 'A CodeInput oncomplete', speak: false });
  let boxes = $state<HTMLElement>();
  const shownError = $derived(error || check.error);

  function typed(v: string) {
    value = v;
    check.error = '';
    oninput?.(v);
  }

  async function complete(v: string) {
    if (check.busy) return;
    const result = await check.run((w) => oncomplete?.(v, w));
    if (!result.ok && !result.skipped) boxes?.querySelector('input')?.focus();
  }
</script>

<div class="sd-field">
  {#if label}<span class="sd-field-label" id={labelId}>{label}</span>{/if}
  <div class="sd-code-row">
  <div class="sd-code" role="group" bind:this={boxes} aria-labelledby={label ? labelId : undefined} use:busy={check.busy} use:codeInput={{ oninput: typed, oncomplete: complete }}>
    {#each { length }, i}
      {#if i > 0 && group && i % group === 0}<span class="sd-code-sep" aria-hidden="true">-</span>{/if}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="sd-code-cell"
        value={initial[i] ?? ''}
        aria-label="Character {i + 1} of {length}"
        aria-invalid={shownError ? 'true' : undefined}
        aria-describedby={shownError || hint || check.spinning ? noteId : undefined}
        autocomplete={i === 0 ? autocomplete : 'off'}
        data-1p-ignore={autocomplete === 'off' ? true : undefined}
        data-lpignore={autocomplete === 'off' ? 'true' : undefined}
        data-form-type="other"
        autocapitalize="characters"
        spellcheck="false"
        inputmode="text"
        autofocus={autofocus && i === 0}
        {disabled}
      />
    {/each}
  </div>
  {#if check.spinning}<span class="sd-spinner" aria-hidden="true"></span>{/if}
  </div>
  {#if name}<input type="hidden" {name} {value} />{/if}
  {#if shownError}
    <span class="sd-field-error" id={noteId} role="alert">{shownError}</span>
  {:else if check.spinning}
    <span class="sd-field-hint" id={noteId} role="status">{check.slow ? messages.slow : messages.checking}</span>
  {:else if hint}
    <span class="sd-field-hint" id={noteId}>{hint}</span>
  {/if}
</div>
