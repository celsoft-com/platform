<!-- Service Dark Checklist: a list of checkboxes, with an optional "all" choice that holds as items change, and drag-to-reorder. -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import { sortable } from '../actions/sortable.js';
  import { Latest, announce } from '../lib/pending.svelte.js';
  import { isSelected } from '../lib/checklist.js';
  import { matches } from '../lib/filter.js';
  import Filter from './Filter.svelte';

  interface Item {
    /** Unique and stable: it is what `checked` holds and what reordering tracks. */
    id: string;
    label: string;
    description?: string;
    /** Can't be checked or unchecked, and "all" never includes it. It can still be reordered. */
    disabled?: boolean;
  }

  type Wait = { signal: AbortSignal; key: string; seq: number };
  /** "all" or "none" (chosen with the All checkbox, holding as items change), or ids checked one by one. */
  type Selection = 'all' | 'none' | string[];

  interface Props {
    /** Bindable when reordering. The items in their current order. */
    items: Item[];
    /**
     * Bindable. "all" or "none" when chosen with the All checkbox, which hold as items are added; or the
     * ids checked one by one, in list order. Store it as given and validate it with ChecklistSelection.
     */
    checked?: Selection;
    /** The list's name, shown above it and used as its accessible name. */
    label: string;
    /** One line under the label. */
    hint?: string;
    /** Adds an All checkbox: it sets the selection to "all", or from "all" to "none"; both hold as items change. */
    selectAll?: boolean;
    /** Adds a drag handle to each row for reordering by pointer or keyboard. Handles hide while filtering. */
    reorder?: boolean;
    /**
     * Adds a filter box that matches labels, descriptions and ids. While it holds text, All acts only on
     * the rows shown and gives plain ids, since "all" and "none" mean the whole list.
     */
    filter?: boolean;
    /** Bindable. What is typed in the filter. */
    query?: string;
    /**
     * After checks change. Return the promise to save them: changes go one at a time, latest wins, and a
     * sentence it resolves to puts the saved checks back and shows the sentence.
     */
    onchange?: (change: { checked: Selection } & Wait) => unknown;
    /** After a reorder. Same rules as onchange; a failure puts the saved order back. */
    onreorder?: (change: { items: Item[]; from: number; to: number } & Wait) => unknown;
  }

  let { items = $bindable(), checked = $bindable('none'), label, hint, selectAll = false, reorder = false, filter = false, query = $bindable(''), onchange, onreorder }: Props = $props();

  const uid = $props.id();
  let error = $state('');

  const filtering = $derived(filter && query.trim() !== '');
  const shown = $derived(filtering ? items.filter((i) => matches(query, i.label, i.description, i.id)) : items);
  const enabled = $derived(items.filter((i) => !i.disabled));
  const shownEnabled = $derived(shown.filter((i) => !i.disabled));
  const shownAll = $derived(shownEnabled.length > 0 && shownEnabled.every((i) => isSelected(checked, i)));
  const shownSome = $derived(!shownAll && shownEnabled.some((i) => isSelected(checked, i)));
  const isAll = $derived(checked === 'all');
  const count = $derived(enabled.filter((i) => isSelected(checked, i)).length);
  const some = $derived(Array.isArray(checked) && items.some((i) => isSelected(checked, i)));
  const copy = (sel: Selection): Selection => (Array.isArray(sel) ? [...sel] : sel);

  // Saving: what the server last accepted, put back if a change fails.
  // svelte-ignore state_referenced_locally
  let acceptedChecks: Selection = copy(checked);
  // svelte-ignore state_referenced_locally
  let acceptedOrder = items.map((i) => i.id);
  const checks = new Latest((r) => {
    if (r.ok) acceptedChecks = copy(checked);
    else if (r.error) {
      checked = copy(acceptedChecks);
      error = r.error;
    }
  }, 'A Checklist onchange');
  const order = new Latest((r) => {
    if (r.ok) acceptedOrder = items.map((i) => i.id);
    else if (r.error) {
      items = acceptedOrder.map((id) => items.find((i) => i.id === id)).filter((i): i is Item => !!i);
      error = r.error;
    }
  }, 'A Checklist onreorder');

  // Keep check order following list order, so `checked` reads top to bottom.
  const ordered = (ids: string[]) => items.map((i) => i.id).filter((id) => ids.includes(id));

  function setChecked(next: Selection) {
    checked = Array.isArray(next) ? ordered(next) : next;
    error = '';
    const snapshot = copy(checked);
    checks.send((w) => onchange?.({ checked: snapshot, ...w }));
  }

  function toggle(item: Item, on: boolean) {
    if (item.disabled) return;
    // A single box always yields plain ids: from "all" every other item it covered, from "none" just this one.
    const ids = checked === 'all' ? enabled.map((i) => i.id) : checked === 'none' ? [] : checked;
    setChecked(on ? [...ids.filter((id) => id !== item.id), item.id] : ids.filter((id) => id !== item.id));
  }

  /**
   * All is a choice, not a bulk check: from "all" it becomes "none", from anything else "all".
   * While filtering it checks or clears only the rows shown, and the result is plain ids.
   */
  function toggleAll() {
    if (!filtering) return setChecked(isAll ? 'none' : 'all');
    const current = selectedNow();
    const ids = shownEnabled.map((i) => i.id);
    setChecked(shownAll ? current.filter((id) => !ids.includes(id)) : [...current.filter((id) => !ids.includes(id)), ...ids]);
  }

  /** The selection as plain ids among today's items. */
  const selectedNow = () => items.filter((i) => isSelected(checked, i)).map((i) => i.id);

  function moveItem(from: number, to: number) {
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    items = next;
  }

  function dropped(from: number, to: number) {
    if (from === to) return;
    error = '';
    const snapshot = [...items];
    if (Array.isArray(checked)) checked = ordered(checked);
    order.send((w) => onreorder?.({ items: snapshot, from, to, ...w }));
  }
</script>

<div class="sd-field sd-checklist" role="group" aria-labelledby="sd-check-{uid}" aria-describedby={hint ? `sd-check-${uid}-hint` : undefined}>
  <div class="sd-checklist-head">
    <span class="sd-field-label" id="sd-check-{uid}">{label}</span>
    {#if selectAll}
      <label class="sd-check-row sd-checklist-all">
        <input
          type="checkbox"
          class="sd-checkbox"
          checked={filtering ? shownAll : isAll}
          indeterminate={filtering ? shownSome : some}
          disabled={filtering && shownEnabled.length === 0}
          onchange={toggleAll}
        />
        <span>{filtering ? 'All shown' : 'All'}</span>
        {#if some && !filtering}<span class="sd-checklist-count">{count} of {enabled.length}</span>{/if}
      </label>
    {/if}
  </div>
  {#if hint}<span class="sd-field-hint" id="sd-check-{uid}-hint">{hint}</span>{/if}
  {#if filter}<Filter bind:value={query} label="Filter {label}" shown={shown.length} total={items.length} />{/if}

  <ul
    class={['sd-checklist-items', reorder && 'sd-checklist-sortable', !Array.isArray(checked) && 'sd-checklist-follow']}
    use:sortable={{
      disabled: !reorder || filtering,
      onmove: moveItem,
      ondrop: dropped,
      announce,
      name: (i: number) => items[i]?.label
    }}
  >
    {#each shown as item, i (item.id)}
      <li class={['sd-checklist-item', item.disabled && 'sd-checklist-disabled']} data-sort-item data-sort-id={item.id}>
        {#if reorder && !filtering}
          <button type="button" class="sd-checklist-handle" data-sort-handle aria-label="Reorder {item.label}, position {i + 1} of {items.length}" aria-roledescription="drag handle" title="Drag, or press Space then use the arrow keys">
            <Icon name="grip-vertical" />
          </button>
        {/if}
        <label class="sd-check-row">
          <input type="checkbox" class="sd-checkbox" checked={isSelected(checked, item)} disabled={item.disabled} aria-describedby={item.description ? `sd-check-${uid}-${i}` : undefined} onchange={(e) => toggle(item, e.currentTarget.checked)} />
          <span class="sd-check-text">
            <span class="sd-check-label">{item.label}</span>
            {#if item.description}<span class="sd-check-desc" id="sd-check-{uid}-{i}">{item.description}</span>{/if}
          </span>
        </label>
      </li>
    {/each}
  </ul>
  {#if filtering && !shown.length}<p class="sd-list-empty">No items match “{query}”.</p>{/if}
  {#if error}<span class="sd-field-error" role="alert">{error}</span>{/if}
</div>
