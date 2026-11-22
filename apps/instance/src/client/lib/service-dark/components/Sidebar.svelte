<!-- Service Dark Sidebar: main navigation, resizable from an icon rail to any width. -->
<script lang="ts">
  import type { Component } from 'svelte';
  import Icon from './Icon.svelte';
  import { resizable as resize } from '../actions/resizable.js';

  interface NavItem {
    id: string;
    label: string;
    /** A Lucide name (built in or registered) or a Lucide Svelte component. */
    icon?: string | Component<any>;
    /** A count shown at the end. Numbers only. */
    badge?: string | number;
    /** Renders the item as a link. Use it for SvelteKit routes. */
    href?: string;
  }

  interface Group {
    label?: string;
    items: NavItem[];
  }

  interface Props {
    product?: string;
    groups?: Group[];
    footer?: NavItem[];
    /** Id of the current item. In SvelteKit, derive it from page.url.pathname. */
    active?: string;
    onselect?: (id: string) => void;
    resizable?: boolean;
    /** Current width in px. Pass the value from a cookie so the first render is right. */
    width?: number;
    defaultWidth?: number;
    minWidth?: number;
    maxWidth?: number;
    /** Below this width only icons show. */
    compactBelow?: number;
    /** localStorage key that remembers the width in the browser. */
    storageKey?: string;
    onresize?: (width: number) => void;
  }

  let {
    product = 'Service',
    groups = [],
    footer = [],
    active = $bindable(),
    onselect,
    resizable = true,
    width = $bindable(),
    defaultWidth = 240,
    minWidth = 56,
    maxWidth,
    compactBelow = 136,
    storageKey,
    onresize
  }: Props = $props();

  const compact = $derived((width ?? defaultWidth) < compactBelow);

  function select(id: string) {
    active = id;
    onselect?.(id);
  }

  function resized(w: number) {
    width = w;
    onresize?.(w);
  }
</script>

{#snippet itemContent(item: NavItem)}
  {#if item.icon}<Icon name={item.icon} />{/if}
  <span class="sd-nav-label">{item.label}</span>
  {#if item.badge != null}<span class="sd-nav-badge">{item.badge}</span>{/if}
{/snippet}

{#snippet navItem(item: NavItem)}
  {#if item.href}
    <a
      class="sd-nav-item"
      href={item.href}
      aria-current={item.id === active ? 'page' : undefined}
      aria-label={compact ? item.label : undefined}
      title={compact ? item.label : undefined}
      onclick={() => select(item.id)}
    >
      {@render itemContent(item)}
    </a>
  {:else}
    <button
      type="button"
      class="sd-nav-item"
      aria-current={item.id === active ? 'page' : undefined}
      aria-label={compact ? item.label : undefined}
      title={compact ? item.label : undefined}
      onclick={() => select(item.id)}
    >
      {@render itemContent(item)}
    </button>
  {/if}
{/snippet}

<nav
  class={['sd-sidebar', compact && 'sd-sidebar-compact']}
  style:width={width != null ? `${width}px` : undefined}
  aria-label="Main"
>
  <div class="sd-side-brand" title={compact ? product : undefined}>
    <span class="sd-side-mark" aria-hidden="true"></span>
    <span class="sd-side-name">{product}</span>
  </div>

  {#each groups as group, i (i)}
    <div class="sd-side-group">
      {#if group.label}<div class="sd-side-label">{group.label}</div>{/if}
      {#each group.items as item (item.id)}{@render navItem(item)}{/each}
    </div>
  {/each}

  {#if footer.length}
    <div class="sd-side-foot">
      {#each footer as item (item.id)}{@render navItem(item)}{/each}
    </div>
  {/if}

  {#if resizable}
    <div
      use:resize={{ width, defaultWidth, min: minWidth, max: maxWidth, compactBelow, storageKey, onresize: resized }}
    ></div>
  {/if}
</nav>
