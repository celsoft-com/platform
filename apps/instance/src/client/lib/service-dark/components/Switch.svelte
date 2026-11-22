<!-- Service Dark Switch: an on/off setting that applies immediately. Waits on an onchange that returns a promise. -->
<script lang="ts">
  import { Pending } from '../lib/pending.svelte.js';

  type Wait = { signal: AbortSignal; key: string };

  interface Props {
    checked?: boolean;
    label?: string;
    disabled?: boolean;
    /** Accessible name when there is no visible label. */
    'aria-label'?: string;
    /**
     * Return the promise to have the switch wait. By default it flips at once and flips back if the
     * promise resolves to a sentence. Clicks are ignored until it answers.
     */
    onchange?: (checked: boolean, wait: Wait) => unknown;
    /** Flip only once onchange succeeds. Use it when the setting has real consequences, such as making something public. */
    wait?: boolean;
    /** Bindable. The sentence from the last failed change. */
    error?: string;
  }

  let { checked = $bindable(false), label, disabled = false, onchange, wait = false, error = $bindable(''), ...rest }: Props = $props();

  const own = new Pending({ name: 'A Switch onchange' });

  $effect(() => {
    error = own.error;
  });

  async function toggle() {
    if (own.busy) return;
    const before = checked;
    const next = !checked;
    if (!wait) checked = next;
    const result = await own.run((w) => onchange?.(next, w));
    if (result.ok) checked = next;
    else if (!result.skipped) checked = before;
  }
</script>

<label class="sd-switch-row">
  <button
    type="button"
    role="switch"
    class={['sd-switch', own.spinning && 'sd-switch-spinning']}
    aria-checked={checked}
    aria-disabled={own.busy ? 'true' : undefined}
    aria-busy={own.spinning ? 'true' : undefined}
    {disabled}
    onclick={toggle}
    {...rest}
  ></button>
  {#if label}<span>{label}</span>{/if}
</label>
