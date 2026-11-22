<!-- Service Dark Filter: the search box above a list. Lists with a filter prop use it; use it for any other list too. -->
<script lang="ts">
  import Icon from './Icon.svelte';

  interface Props {
    /** Bindable. What has been typed. */
    value?: string;
    /** Accessible name, such as "Filter scopes". */
    label?: string;
    placeholder?: string;
    /** Rows shown and rows in all, announced as people type, such as 3 of 12. */
    shown?: number;
    total?: number;
  }

  let { value = $bindable(''), label = 'Filter', placeholder = 'Filter', shown, total }: Props = $props();
</script>

<div class="sd-filter">
  <Icon name="search" />
  <input
    class="sd-input"
    type="search"
    aria-label={label}
    {placeholder}
    autocomplete="off"
    spellcheck="false"
    bind:value
    onkeydown={(e) => {
      if (e.key === 'Escape' && value) {
        e.preventDefault();
        value = '';
      }
    }}
  />
  {#if value && shown != null && total != null}<span class="sd-sr" role="status">{shown} of {total} shown</span>{/if}
</div>
