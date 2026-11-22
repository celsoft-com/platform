<!-- Service Dark Dialog: a native modal <dialog> for one focused task or confirmation. With onsubmit it waits, closes on success and stays open on error. -->
<script lang="ts">
  import type { Component, Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import IconButton from './IconButton.svelte';
  import { modal } from '../actions/modal.js';
  import { busy } from '../actions/busy.js';
  import { Pending, providePending } from '../lib/pending.svelte.js';

  /** submitter is the button that sent the form; give buttons a value to tell actions apart, such as value="delete". */
  type Wait = { signal: AbortSignal; key: string; submitter: HTMLButtonElement | null };

  interface Props {
    /** Bindable. Escape, the close button and a click on the backdrop set it to false. */
    open?: boolean;
    title: string;
    description?: string;
    /** Shown beside the title: a Lucide name (built in or registered) or a Lucide Svelte component. */
    icon?: string | Component<any>;
    /** sm is 400px wide, md 480px, lg 640px for browsing, such as FileBrowser. */
    size?: 'sm' | 'md' | 'lg';
    onclose?: () => void;
    /**
     * Makes the body and footer one form. On submit the dialog waits for this promise: fields lock, the
     * submit Button spins, and Cancel, Escape and the close button are blocked. Resolve to nothing to close,
     * to one sentence to stay open and show it, or to false to stay open with nothing to add (such as when
     * fields failed their schema and show their own errors). Read once, when the dialog is created.
     */
    onsubmit?: (wait: Wait) => Promise<string | void | false>;
    /** While waiting, Cancel, Escape and the close button stop the wait and close instead of being blocked. */
    abortable?: boolean;
    children?: Snippet;
    /** Buttons: cancel first as quiet, then the action. With onsubmit, the action is a type="submit" Button. */
    footer?: Snippet;
  }

  let { open = $bindable(false), title, description, icon, size = 'md', onclose, onsubmit, abortable = false, children, footer }: Props = $props();

  const uid = $props.id();
  // svelte-ignore state_referenced_locally
  const wait = onsubmit ? providePending(new Pending({ name: 'A Dialog onsubmit', abortable })) : undefined;

  $effect(() => {
    if (!open && wait) wait.error = '';
  });

  function close() {
    if (wait?.busy) {
      if (!wait.abortable) return;
      wait.abort();
    }
    open = false;
    onclose?.();
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!wait || !onsubmit) return;
    const submitter = (e.submitter as HTMLButtonElement | null) ?? null;
    const result = await wait.run((w: { signal: AbortSignal; key: string }) => onsubmit({ ...w, submitter }));
    if (result.ok) {
      open = false;
      onclose?.();
    }
  }
</script>

{#snippet content()}
  {#if children || wait?.error}
    <div class="sd-dialog-body">
      {@render children?.()}
      {#if wait?.error}<p class="sd-dialog-error" role="alert">{wait.error}</p>{/if}
    </div>
  {/if}
  {#if footer}<footer class="sd-dialog-foot">{@render footer()}</footer>{/if}
{/snippet}

<dialog
  class={['sd-dialog', size === 'sm' && 'sd-dialog-sm', size === 'lg' && 'sd-dialog-lg']}
  aria-labelledby="sd-dialog-{uid}-title"
  aria-describedby={description ? `sd-dialog-${uid}-desc` : undefined}
  use:modal={{ open, onclose: close }}
>
  <header class="sd-dialog-head">
    {#if icon}<span class="sd-dialog-icon"><Icon name={icon} /></span>{/if}
    <div class="sd-dialog-titles">
      <h2 class="sd-dialog-title" id="sd-dialog-{uid}-title">{title}</h2>
      {#if description}<p class="sd-dialog-sub" id="sd-dialog-{uid}-desc">{description}</p>{/if}
    </div>
    <IconButton icon="x" label="Close" cancel onclick={close} />
  </header>
  {#if wait}
    <form class="sd-dialog-form" novalidate onsubmit={submit} use:busy={wait.busy}>{@render content()}</form>
  {:else}
    {@render content()}
  {/if}
</dialog>
