<!-- Service Dark TokenField: shows a secret or ID with reveal and copy. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import IconButton from './IconButton.svelte';
  import { copy } from '../actions/copy.js';

  interface Props {
    label?: string;
    value: string;
    /** Hide the middle, keeping the prefix and last 4 characters. */
    masked?: boolean;
    /** Visible prefix when masked. Defaults to everything up to the second underscore. */
    prefix?: string;
    hint?: string;
    /** More buttons inside the field, after copy, such as Edit. */
    actions?: Snippet;
  }

  let { label, value, masked = false, prefix, hint, actions }: Props = $props();

  let revealed = $state(false);
  let copied = $state(false);

  const uid = $props.id();
  const shownPrefix = $derived(prefix ?? value.slice(0, value.indexOf('_', 4) + 1));
  const shown = $derived(
    !masked || revealed
      ? value
      : shownPrefix + '\u2022'.repeat(Math.max(6, Math.min(12, value.length - shownPrefix.length - 4))) + value.slice(-4)
  );
</script>

<div class="sd-field">
  {#if label}<span class="sd-field-label" id="sd-token-{uid}">{label}</span>{/if}
  <div class="sd-token" role="group" aria-labelledby={label ? `sd-token-${uid}` : undefined}>
    <code>{shown}</code>
    {#if copied}<span class="sd-token-copied" role="status">Copied</span>{/if}
    {#if masked}
      <IconButton icon={revealed ? 'eye-off' : 'eye'} label={revealed ? 'Hide secret' : 'Reveal secret'} onclick={() => (revealed = !revealed)} />
    {/if}
    <button type="button" class="sd-iconbtn" aria-label="Copy" title="Copy" use:copy={{ text: value, oncopied: (v: boolean) => (copied = v) }}>
      <Icon name="copy" />
    </button>
    {@render actions?.()}
  </div>
  {#if hint}<span class="sd-field-hint">{hint}</span>{/if}
</div>
