<!-- Service Dark Button: primary, secondary, quiet or danger. Waits on an onclick that returns a promise. -->
<script lang="ts">
  import type { Component, Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Icon from './Icon.svelte';
  import { Pending, pendingContext, clickWait, buttonState } from '../lib/pending.svelte.js';

  type Wait = { signal: AbortSignal; key: string };

  interface Props extends Omit<HTMLButtonAttributes, 'onclick'> {
    variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
    size?: 'sm' | 'md';
    /** Shown before the label: a Lucide name (built in or registered) or a Lucide Svelte component. */
    icon?: string | Component<any>;
    /** Full width of its container. */
    block?: boolean;
    /** Return the promise to have the button wait: () => save(), not () => { save(); }. Resolve to a sentence to report an error. */
    onclick?: (event: MouseEvent, wait: Wait) => unknown;
    /** Stays usable while the surrounding Dialog or form waits, if that wait is abortable, and stops it. */
    cancel?: boolean;
    /** Bindable. The sentence from the last failed wait; show it near the button. */
    error?: string;
    children?: Snippet;
  }

  let {
    variant = 'secondary',
    size = 'md',
    icon,
    block = false,
    type = 'button',
    cancel = false,
    error = $bindable(''),
    onclick,
    class: className,
    children,
    ...rest
  }: Props = $props();

  const own = new Pending({ name: 'A Button onclick' });
  const form = pendingContext();
  const state = $derived(buttonState({ own, form, submit: type === 'submit', cancel }));

  $effect(() => {
    error = own.error;
  });
</script>

<button
  {type}
  class={['sd-btn', `sd-btn-${variant}`, size === 'sm' && 'sd-btn-sm', block && 'sd-btn-block', state.spinning && 'sd-btn-spinning', !icon && 'sd-btn-plain', className]}
  aria-disabled={state.blocked ? 'true' : undefined}
  aria-busy={state.spinning ? 'true' : undefined}
  onclick={(e) => clickWait(e, { own, form, submit: type === 'submit', cancel, onclick })}
  {...rest}
>
  {#if state.spinning}<span class="sd-spinner" aria-hidden="true"></span>{:else if icon}<Icon name={icon} />{/if}
  <span class="sd-btn-label">{@render children?.()}</span>
</button>
