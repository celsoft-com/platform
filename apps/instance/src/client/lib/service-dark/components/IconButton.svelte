<!-- Service Dark IconButton: a square icon-only button with a required label. Waits on an onclick that returns a promise. -->
<script lang="ts">
  import type { Component } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Icon from './Icon.svelte';
  import { Pending, pendingContext, clickWait, buttonState } from '../lib/pending.svelte.js';

  type Wait = { signal: AbortSignal; key: string };

  interface Props extends Omit<HTMLButtonAttributes, 'onclick'> {
    /** A Lucide name (built in or registered) or a Lucide Svelte component. */
    icon: string | Component<any>;
    /** Accessible name and tooltip. Required: the icon has no text. */
    label: string;
    /** Return the promise to have the button wait. Resolve to a sentence to report an error. */
    onclick?: (event: MouseEvent, wait: Wait) => unknown;
    /** Stays usable while the surrounding Dialog or form waits, if that wait is abortable, and stops it. */
    cancel?: boolean;
    /** Bindable. The sentence from the last failed wait. */
    error?: string;
  }

  let { icon, label, type = 'button', cancel = false, error = $bindable(''), onclick, class: className, ...rest }: Props = $props();

  const own = new Pending({ name: 'An IconButton onclick' });
  const form = pendingContext();
  const state = $derived(buttonState({ own, form, submit: type === 'submit', cancel }));

  $effect(() => {
    error = own.error;
  });
</script>

<button
  {type}
  class={['sd-iconbtn', className]}
  aria-label={label}
  title={label}
  aria-disabled={state.blocked ? 'true' : undefined}
  aria-busy={state.spinning ? 'true' : undefined}
  onclick={(e) => clickWait(e, { own, form, submit: type === 'submit', cancel, onclick })}
  {...rest}
>
  {#if state.spinning}<span class="sd-spinner" aria-hidden="true"></span>{:else}<Icon name={icon} />{/if}
</button>
