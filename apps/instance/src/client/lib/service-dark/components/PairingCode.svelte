<!-- Service Dark PairingCode: the short code a device shows while it waits to be approved. -->
<script lang="ts">
  import Badge from './Badge.svelte';
  import Button from './Button.svelte';

  type Wait = { signal: AbortSignal; key: string };

  interface Props {
    /** The code with a hyphen, such as "QF7-K2M". */
    code: string;
    status?: 'waiting' | 'paired' | 'expired';
    /** Time left while waiting, such as "4:52". */
    expiresIn?: string;
    /** Device name, shown once paired. */
    device?: string;
    /** Shows "New code" once the code expires. Return the promise: the button waits until the new code arrives. */
    onrenew?: (event: MouseEvent, wait: Wait) => unknown;
  }

  let { code, status = 'waiting', expiresIn, device, onrenew }: Props = $props();
  let renewError = $state('');

  const parts = $derived(code.split('-'));
  const spoken = $derived(code.replace(/-/g, '').split('').join(' '));
</script>

<div class="sd-pair">
  <div class="sd-pair-code" role="img" aria-label="Pairing code {spoken}">
    {#each parts as part, i}{#if i > 0}<span>-</span>{/if}{part}{/each}
  </div>
  {#if status === 'paired'}
    <Badge tone="success" dot>Paired{device ? ` with ${device}` : ''}</Badge>
  {:else if status === 'expired'}
    <Badge tone="danger" dot>Code expired</Badge>
    {#if onrenew}
      <Button size="sm" icon="refresh-cw" onclick={onrenew} bind:error={renewError}>New code</Button>
      {#if renewError}<span class="sd-field-error" role="alert">{renewError}</span>{/if}
    {/if}
  {:else}
    <span class="sd-pair-status" role="status">
      <span class="sd-pulse" aria-hidden="true"></span>
      Waiting for device{expiresIn ? ` \u00b7 expires in ${expiresIn}` : ''}
    </span>
  {/if}
</div>
