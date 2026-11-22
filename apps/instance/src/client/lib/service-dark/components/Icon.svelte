<!-- Service Dark Icon: one icon at 16px with a 2px stroke, colored by currentColor. Any Lucide icon fits. -->
<script lang="ts">
  import type { Component } from 'svelte';
  import { resolveIcon } from '../lib/icons.js';

  interface Props {
    /**
     * A Lucide name in kebab case, such as "key-round", built in or added with registerIcons;
     * or a Lucide Svelte component, such as Rocket from @lucide/svelte.
     */
    name: string | Component<any>;
    class?: string;
  }

  let { name, class: className = '' }: Props = $props();

  const icon = $derived(resolveIcon(name));
</script>

{#if icon && 'component' in icon}
  <!-- Same box, stroke and color as the built-in icons, so it lines up anywhere. -->
  <icon.component class={['sd-icon', className]} size={16} strokeWidth={2} aria-hidden="true" />
{:else}
  <!-- An unknown name still takes its 16px, so labels never shift. -->
  <svg class={['sd-icon', className]} viewBox="0 0 24 24" aria-hidden="true">{@html icon && 'markup' in icon ? icon.markup : ''}</svg>
{/if}
