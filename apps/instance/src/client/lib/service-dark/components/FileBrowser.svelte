<!-- Service Dark FileBrowser: a dialog to browse folders and pick files or a folder, from any backend. -->
<script lang="ts" module>
  /** One entry in a folder, as the backend returns it. */
  export interface FileEntry {
    name: string;
    /** Full path, passed back to list() to open a folder and to onselect when chosen. */
    path: string;
    type: 'file' | 'folder';
    /** Optional, shown when given: bytes, and an ISO date or anything Date can parse. */
    size?: number;
    modified?: string;
  }
</script>

<script lang="ts">
  import { tick, untrack } from 'svelte';
  import Dialog from './Dialog.svelte';
  import Button from './Button.svelte';
  import IconButton from './IconButton.svelte';
  import Icon from './Icon.svelte';
  import Filter from './Filter.svelte';
  import { matches } from '../lib/filter.js';
  import { timing, messages } from '../lib/pending.svelte.js';

  type Wait = { signal: AbortSignal };

  interface Props {
    /** Bindable. */
    open?: boolean;
    title?: string;
    description?: string;
    /** What can be chosen: files, or a folder (the open one, or one selected in it). */
    mode?: 'file' | 'folder';
    /** Files only: allow several, toggled by click or Space. */
    multiple?: boolean;
    /** Files only: extensions that can be chosen, such as ['.json', '.yaml']; others show dimmed. */
    accept?: string[];
    /** The folder to start in, such as the last one used. */
    path?: string;
    /** The top folder, which the breadcrumb starts from and Up stops at. */
    root?: string;
    /** Name shown for the root in the breadcrumb. */
    rootLabel?: string;
    /** Adds a filter box for the open folder. */
    filter?: boolean;
    /**
     * The backend: the entries in a folder. Return the promise; pass signal to fetch so opening another
     * folder cancels this one. Resolve to a sentence instead of entries to show it with Retry.
     */
    list: (path: string, wait: Wait) => Promise<FileEntry[] | string>;
    /**
     * Called by Select with the chosen paths: files, or one folder. Return the promise; the dialog waits,
     * closes on success, and stays open showing a sentence it resolves to.
     */
    onselect: (choice: { paths: string[]; entries: FileEntry[] }) => Promise<string | void> | string | void;
    onclose?: () => void;
  }

  let {
    open = $bindable(false),
    title,
    description,
    mode = 'file',
    multiple = false,
    accept,
    path = '/',
    root = '/',
    rootLabel = 'Home',
    filter = false,
    list,
    onselect,
    onclose
  }: Props = $props();

  const uid = $props.id();
  // svelte-ignore state_referenced_locally
  let here = $state(path);
  let entries = $state<FileEntry[]>([]);
  let selected = $state<string[]>([]);
  let active = $state(0);
  let query = $state('');
  let loading = $state(false);
  let spinning = $state(false);
  let slow = $state(false);
  let failed = $state('');
  let listbox = $state<HTMLElement>();
  let controller: AbortController | null = null;
  /** Put focus back on the list once a folder loads, so keyboard browsing never drops to the page. */
  let refocus = false;

  const name = $derived(title ?? (mode === 'folder' ? 'Choose a folder' : multiple ? 'Choose files' : 'Choose a file'));
  const sep = '/';
  const trim = (p: string) => (p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p);
  const rootPath = $derived(trim(root));
  const crumbs = $derived.by(() => {
    const rel = trim(here).slice(rootPath.length).split(sep).filter(Boolean);
    const out = [{ label: rootLabel, path: rootPath }];
    let acc = rootPath;
    for (const part of rel) {
      acc = acc.endsWith(sep) ? acc + part : acc + sep + part;
      out.push({ label: part, path: acc });
    }
    return out;
  });
  const atRoot = $derived(trim(here) === rootPath);

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const sorted = $derived([...entries].sort((a, b) => (a.type === b.type ? collator.compare(a.name, b.name) : a.type === 'folder' ? -1 : 1)));
  const shown = $derived(filter ? sorted.filter((e) => matches(query, e.name)) : sorted);
  const allowed = (e: FileEntry) =>
    e.type === 'folder' ? mode === 'folder' : mode === 'file' && (!accept?.length || accept.some((x) => e.name.toLowerCase().endsWith(x.toLowerCase())));
  const chosen = $derived(entries.filter((e) => selected.includes(e.path)));

  // Open the start folder each time the dialog opens.
  $effect(() => {
    const start = path;
    if (!open) return untrack(() => controller?.abort());
    refocus = true;
    untrack(() => navigate(start));
  });

  async function navigate(to: string) {
    if (listbox?.contains(document.activeElement) || listbox === document.activeElement) refocus = true;
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    here = trim(to) || rootPath;
    selected = [];
    active = 0;
    query = '';
    failed = '';
    loading = true;
    slow = false;
    const spin = setTimeout(() => !mine.signal.aborted && (spinning = true), timing.spinnerAfter);
    const late = setTimeout(() => !mine.signal.aborted && (slow = true), timing.slowAfter);
    let result: FileEntry[] | string;
    try {
      result = await list(here, { signal: mine.signal });
    } catch (e) {
      if (mine.signal.aborted) return;
      console.error(e);
      result = messages.failed;
    } finally {
      clearTimeout(spin);
      clearTimeout(late);
    }
    if (mine.signal.aborted) return;
    loading = spinning = slow = false;
    if (typeof result === 'string') {
      failed = result;
      entries = [];
    } else entries = result;
    if (refocus) {
      refocus = false;
      await tick();
      document.getElementById(`sd-fb-${uid}-list`)?.focus();
    }
  }

  function up() {
    if (atRoot) return;
    return navigate(crumbs[crumbs.length - 2].path);
  }

  function cancel() {
    open = false;
    onclose?.();
  }

  function choose(e: FileEntry) {
    if (!allowed(e)) return;
    if (multiple && mode === 'file') selected = selected.includes(e.path) ? selected.filter((p) => p !== e.path) : [...selected, e.path];
    else selected = selected[0] === e.path ? [] : [e.path];
  }

  function activate(e: FileEntry) {
    if (e.type === 'folder') navigate(e.path);
    else if (allowed(e)) {
      selected = multiple ? (selected.includes(e.path) ? selected : [...selected, e.path]) : [e.path];
      listbox?.closest('form')?.requestSubmit();
    }
  }

  // Listbox keys: arrows move, Enter opens a folder or chooses a file, Space selects, Backspace goes up.
  function keys(e: KeyboardEvent) {
    const n = shown.length;
    if (e.key === 'Backspace') return (e.preventDefault(), up());
    if (!n) return;
    const go = (i: number) => {
      active = Math.max(0, Math.min(n - 1, i));
      document.getElementById(`sd-fb-${uid}-${active}`)?.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown') go(active + 1);
    else if (e.key === 'ArrowUp') go(active - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(n - 1);
    else if (e.key === 'Enter') activate(shown[active]);
    else if (e.key === ' ') choose(shown[active]);
    else return;
    e.preventDefault();
  }

  async function submit(): Promise<string | void | false> {
    const paths = mode === 'folder' && !selected.length ? [here] : selected;
    if (!paths.length) return false;
    const picked = mode === 'folder' && !selected.length ? [{ name: crumbs.at(-1)!.label, path: here, type: 'folder' as const }] : chosen;
    const answer = await onselect({ paths, entries: picked });
    if (typeof answer === 'string' && answer) return answer;
  }

  const size = (b?: number) => (b == null ? '' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(1)} GB`);
  // A date without a time ("2026-03-01") is a calendar day, so show it as written, not shifted to local time.
  const date = (d?: string) => (d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: /^\d{4}-\d{2}-\d{2}$/.test(d) ? 'UTC' : undefined }) : '');
  const selectLabel = $derived(mode === 'folder' ? (selected.length ? 'Select folder' : 'Select this folder') : selected.length > 1 ? `Select ${selected.length} files` : 'Select');
</script>

<Dialog bind:open title={name} {description} icon={mode === 'folder' ? 'folder' : 'file'} size="lg" {onclose} onsubmit={submit}>
  <div class="sd-fb">
    <div class="sd-fb-bar">
      <IconButton icon="arrow-up" label="Up one folder" disabled={atRoot || loading} onclick={up} />
      <nav class="sd-fb-crumbs" aria-label="Folder path">
        <ol>
          {#each crumbs as c, i (c.path)}
            <li>
              {#if i > 0}<Icon name="chevron-right" />{/if}
              {#if i === crumbs.length - 1}
                <span aria-current="location">{c.label}</span>
              {:else}
                <button type="button" onclick={() => navigate(c.path)}>{c.label}</button>
              {/if}
            </li>
          {/each}
        </ol>
      </nav>
    </div>
    {#if filter}
      <!-- Enter in the filter moves to the list instead of submitting the dialog. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); listbox?.focus(); } }}>
        <Filter bind:value={query} label="Filter this folder" shown={shown.length} total={entries.length} />
      </div>
    {/if}

    <div class="sd-fb-list" aria-busy={loading ? 'true' : undefined}>
      {#if failed}
        <div class="sd-fb-note" role="alert">
          <span class="sd-field-error">{failed}</span>
          <Button size="sm" icon="refresh-cw" onclick={() => navigate(here)}>Retry</Button>
        </div>
      {:else if spinning}
        <div class="sd-fb-note" role="status"><span class="sd-spinner" aria-hidden="true"></span>{slow ? messages.slow : 'Loading'}</div>
      {:else if !loading && !shown.length}
        <p class="sd-fb-note">{query ? `Nothing here matches “${query}”.` : 'This folder is empty.'}</p>
      {:else if !loading}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <ul
          class="sd-fb-items"
          id="sd-fb-{uid}-list"
          role="listbox"
          tabindex="0"
          aria-label="Contents of {crumbs.at(-1)?.label}"
          aria-multiselectable={multiple ? 'true' : undefined}
          aria-activedescendant={shown.length ? `sd-fb-${uid}-${active}` : undefined}
          bind:this={listbox}
          onkeydown={keys}
        >
          {#each shown as e, i (e.path)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <li
              id="sd-fb-{uid}-{i}"
              role="option"
              class={['sd-fb-item', i === active && 'sd-fb-active', !allowed(e) && e.type === 'file' && 'sd-fb-dim']}
              aria-selected={selected.includes(e.path)}
              aria-disabled={!allowed(e) && e.type === 'file' ? 'true' : undefined}
              onclick={() => {
                active = i;
                choose(e);
              }}
              ondblclick={() => activate(e)}
            >
              <Icon name={e.type} />
              <span class="sd-fb-name">{e.name}</span>
              {#if e.type === 'folder'}<Icon name="chevron-right" class="sd-fb-go" />{:else}<span class="sd-fb-meta">{size(e.size)}</span>{/if}
              <span class="sd-fb-meta">{date(e.modified)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>

  {#snippet footer()}
    <span class="sd-fb-picked" title={mode === 'folder' && !selected.length ? here : selected.join('\n')}>
      {mode === 'folder' && !selected.length ? here : selected.length === 1 ? selected[0] : selected.length ? `${selected.length} files` : 'Nothing selected'}
    </span>
    <Button variant="quiet" cancel onclick={cancel}>Cancel</Button>
    <Button type="submit" variant="primary" disabled={loading || !!failed || (mode === 'file' && !selected.length)}>{selectLabel}</Button>
  {/snippet}
</Dialog>
