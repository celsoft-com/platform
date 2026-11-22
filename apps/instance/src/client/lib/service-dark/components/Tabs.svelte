<!-- Service Dark Tabs: switches between sibling views. Arrow keys move between tabs. -->
<script lang="ts">
  interface Tab {
    id: string;
    label: string;
    count?: number;
  }

  interface Props {
    items: Tab[];
    value?: string;
    /** Accessible name for the tab list. */
    label?: string;
    onchange?: (id: string) => void;
  }

  let { items, value = $bindable(), label = 'Sections', onchange }: Props = $props();

  const current = $derived(value ?? items[0]?.id);
  let list: HTMLDivElement;

  function select(id: string) {
    value = id;
    onchange?.(id);
  }

  function onkeydown(e: KeyboardEvent) {
    const i = items.findIndex((t) => t.id === current);
    const last = items.length - 1;
    const next = { ArrowRight: i === last ? 0 : i + 1, ArrowLeft: i === 0 ? last : i - 1, Home: 0, End: last }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(items[next].id);
    list.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  }
</script>

<div class="sd-tabs" role="tablist" aria-label={label} tabindex="-1" bind:this={list} {onkeydown}>
  {#each items as tab (tab.id)}
    <button
      type="button"
      role="tab"
      class="sd-tab"
      aria-selected={tab.id === current}
      tabindex={tab.id === current ? 0 : -1}
      onclick={() => select(tab.id)}
    >
      {tab.label}
      {#if tab.count != null}<span class="sd-tab-count">{tab.count}</span>{/if}
    </button>
  {/each}
</div>
