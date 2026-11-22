<!-- Service Dark SaveBar: shows unsaved changes with Discard and Save, for edits that apply only when saved. -->
<script lang="ts">
  import Button from './Button.svelte';
  import { Pending, messages } from '../lib/pending.svelte.js';

  type Wait = { signal: AbortSignal; key: string };

  interface Props {
    /** How many changes are unsaved. The bar shows only while there is at least one. */
    changes: number;
    /** Forces the saving state. Not needed when onsave returns its promise. */
    saving?: boolean;
    /** One sentence saying why the last save failed and what to do. A sentence onsave resolves to shows here too. */
    error?: string;
    /** Save is disabled while false, such as while a change is invalid. */
    valid?: boolean;
    /** Keep the bar in place with no changes too, so Save never moves. Use it where the bar has a fixed spot. */
    persistent?: boolean;
    /** Return the promise: the bar waits, blocks both buttons and shows "Saving". Resolve to a sentence to report an error. */
    onsave?: (wait: Wait) => Promise<string | void> | string | void;
    ondiscard?: () => void;
  }

  let { changes, saving = false, error, valid = true, persistent = false, onsave, ondiscard }: Props = $props();

  const wait = new Pending({ name: 'A SaveBar onsave', speak: false });
  const busy = $derived(saving || wait.busy);
  const shownError = $derived(error || wait.error);

  // A new edit makes the last error stale.
  $effect(() => {
    void changes;
    wait.error = '';
  });

  function save() {
    return wait.run((w) => onsave?.(w));
  }
</script>

{#if changes > 0 || persistent}
  <div class={['sd-savebar', persistent && 'sd-savebar-persistent', changes > 0 && 'sd-savebar-dirty', changes > 0 && !valid && 'sd-savebar-invalid']} role="region" aria-label="Unsaved changes" aria-busy={busy ? 'true' : undefined}>
    <span class="sd-savebar-text" role="status">
      {#if shownError}<span class="sd-field-error">{shownError}</span>{:else if wait.slow}{messages.slow}{:else if saving || wait.spinning}Saving{:else if changes === 0}No changes{:else if !valid}Fix errors to save{:else}{changes === 1 ? '1 unsaved change' : `${changes} unsaved changes`}{/if}
    </span>
    <!-- Discard is never focused during a save, so a plain disabled is safe here. Save keeps focus and blocks itself. -->
    <Button variant="quiet" size="sm" disabled={busy || changes === 0} onclick={() => ondiscard?.()}>Discard</Button>
    <Button variant="primary" size="sm" disabled={!valid || changes === 0} onclick={() => save()}>Save</Button>
  </div>
{/if}
