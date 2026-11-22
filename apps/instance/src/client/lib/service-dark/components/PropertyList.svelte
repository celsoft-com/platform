<!-- Service Dark PropertyList: a key/value panel for an object's properties, with an optional filter. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import IconButton from './IconButton.svelte';
  import Filter from './Filter.svelte';
  import { matches } from '../lib/filter.js';
  import { copy } from '../actions/copy.js';

  interface Row {
    key: string;
    value: string;
    /** Monospace for machine strings. */
    mono?: boolean;
    /** Show a copy button on hover and focus. */
    copy?: boolean;
    /** Show an edit button that calls onedit. */
    editable?: boolean;
    /** Small note under the key, such as a unit or time zone. */
    hint?: string;
  }

  interface Props {
    title?: string;
    description?: string;
    rows: Row[];
    /** Buttons for the panel header. */
    actions?: Snippet;
    onedit?: (key: string) => void;
    /** Adds a filter box that matches keys, values and hints. */
    filter?: boolean;
    /** Bindable. What is typed in the filter. */
    query?: string;
  }

  let { title, description, rows, actions, onedit, filter = false, query = $bindable('') }: Props = $props();

  const shown = $derived(filter ? rows.filter((r) => matches(query, r.key, r.value, r.hint)) : rows);
</script>

<section class="sd-panel">
  {#if title || actions}
    <header class="sd-panel-head">
      <div>
        {#if title}<h3 class="sd-panel-title">{title}</h3>{/if}
        {#if description}<p class="sd-panel-sub">{description}</p>{/if}
      </div>
      {@render actions?.()}
    </header>
  {/if}
  {#if filter}
    <div class="sd-props-filter"><Filter bind:value={query} label="Filter {title ?? 'properties'}" shown={shown.length} total={rows.length} /></div>
  {/if}
  <dl class="sd-props">
    {#each shown as row (row.key)}
      <div class="sd-prop">
        <dt>{row.key}{#if row.hint}<small>{row.hint}</small>{/if}</dt>
        <dd class={[row.mono && 'sd-mono']} title={row.value}>{row.value}</dd>
        <div class="sd-prop-act">
          {#if row.copy}
            <button type="button" class="sd-iconbtn" aria-label="Copy {row.key}" title="Copy {row.key}" use:copy={{ text: row.value }}>
              <Icon name="copy" />
            </button>
          {/if}
          {#if row.editable}
            <IconButton icon="pencil" label="Edit {row.key}" onclick={() => onedit?.(row.key)} />
          {/if}
        </div>
      </div>
    {/each}
  </dl>
  {#if filter && query && !shown.length}<p class="sd-list-empty">No properties match “{query}”.</p>{/if}
</section>
