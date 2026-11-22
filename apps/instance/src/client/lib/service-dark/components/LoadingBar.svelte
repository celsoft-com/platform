<!-- Service Dark LoadingBar: a thin bar along the top of the app while a page loads. Blocks nothing. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import { timing, messages } from '../lib/pending.svelte.js';

  interface Props {
    /** True while waiting, such as !!navigating.to from $app/state. */
    active: boolean;
    /** What is loading, for screen readers. */
    label?: string;
  }

  let { active, label = 'Loading page' }: Props = $props();

  let shown = $state(false);
  let slow = $state(false);
  let hide: ReturnType<typeof setTimeout> | undefined;

  // Same timing as every other wait: appears after spinnerAfter, stays at least spinnerAtLeast.
  $effect(() => {
    if (!active) return;
    clearTimeout(hide);
    let shownAt = untrack(() => shown) ? performance.now() : 0;
    const show = setTimeout(() => {
      shown = true;
      shownAt = performance.now();
    }, timing.spinnerAfter);
    const late = setTimeout(() => (slow = true), timing.slowAfter);
    return () => {
      clearTimeout(show);
      clearTimeout(late);
      slow = false;
      const left = shownAt ? timing.spinnerAtLeast - (performance.now() - shownAt) : 0;
      if (left > 0) hide = setTimeout(() => (shown = false), left);
      else shown = false;
    };
  });
</script>

{#if shown}
  <div class="sd-loadingbar" role="progressbar" aria-label={slow ? `${label}. ${messages.slow}` : label}></div>
{/if}
