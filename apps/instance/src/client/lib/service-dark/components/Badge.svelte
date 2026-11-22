<!-- Service Dark Badge: a short status or scope label, or a chip in any color fitted to the palette. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { colorStyle } from '../lib/colors.js';

  interface Props {
    tone?: 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger';
    /** A color instead of a tone, as #rrggbb, such as one a person chose. Fitted to the palette in both themes. */
    color?: string | null;
    /** Seeds a color when there is no color: the same string or number always gets the same color. */
    seed?: string | number | null;
    /** With color or seed: a tinted ground in that color. */
    fill?: boolean;
    /** A leading dot for live status. The text still carries the meaning. */
    dot?: boolean;
    children?: Snippet;
  }

  let { tone = 'neutral', color, seed, fill = false, dot = false, children }: Props = $props();

  const style = $derived(colorStyle({ color, seed }));
</script>

{#if style}
  <span class={['sd-badge', 'sd-cat', fill && 'sd-badge-fill', dot && 'sd-badge-dot']} {style}>{@render children?.()}</span>
{:else}
  <span class={['sd-badge', tone !== 'neutral' && `sd-badge-${tone}`, dot && 'sd-badge-dot']}>{@render children?.()}</span>
{/if}
