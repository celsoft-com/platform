<!-- What a step did: each thing it confirmed, then the sentence that stopped it, if one did. -->
<script lang="ts">
  import { Icon } from './lib/service-dark';

  let { done = [], error = '' }: { done?: string[]; error?: string } = $props();
</script>

{#if done.length || error}
  <ul class="report body-sm" aria-live="polite">
    {#each done as line}<li><span class="ok"><Icon name="check" /></span>{line}</li>{/each}
    {#if error}<li class="sd-field-error" role="alert"><Icon name="x" />{error}</li>{/if}
  </ul>
{/if}

<style>
  .report { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  .report li { display: flex; gap: var(--space-2); align-items: flex-start; }
  .ok { color: var(--success); }
</style>
