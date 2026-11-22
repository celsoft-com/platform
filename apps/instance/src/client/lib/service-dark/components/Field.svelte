<!-- Service Dark Field: a labeled text input with a hint or an error. -->
<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';

  interface Props extends HTMLInputAttributes {
    label?: string;
    /** Help text under the input. Hidden while there is an error. */
    hint?: string;
    /** One sentence that says what to fix. Sets aria-invalid. */
    error?: string;
    /** Monospace for machine strings: IDs, URLs, keys. */
    mono?: boolean;
    value?: string;
  }

  let { label, hint, error, mono = false, value = $bindable(''), id, class: className, ...rest }: Props = $props();

  const uid = $props.id();
  const inputId = $derived(id ?? `sd-field-${uid}`);
  const noteId = $derived(`${inputId}-note`);
</script>

<div class={['sd-field', className]}>
  {#if label}<label class="sd-field-label" for={inputId}>{label}</label>{/if}
  <input
    id={inputId}
    class={['sd-input', mono && 'sd-input-mono']}
    bind:value
    aria-invalid={error ? 'true' : undefined}
    aria-describedby={error || hint ? noteId : undefined}
    {...rest}
  />
  {#if error}
    <div class="sd-field-error" id={noteId}>{error}</div>
  {:else if hint}
    <div class="sd-field-hint" id={noteId}>{hint}</div>
  {/if}
</div>
