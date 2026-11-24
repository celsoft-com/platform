<!-- One app: where it is, deploying it, its secrets and settings, its runs, and removing it. -->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Badge, Button, Dialog, Field, Icon, PropertyList, Switch } from './lib/service-dark';
  import Report from './Report.svelte';
  import { get, post, type AppRow, type RunView, type StepResult } from './api';
  import { runTone, runWord, when } from './runs';

  let { name, go }: { name: string; go: (path: string) => void } = $props();

  interface Page {
    app: AppRow;
    admins: string[];
    build: { install?: string; build?: string; test?: string };
    runs: RunView[];
    secrets: { name: string; set: boolean }[];
    installed: boolean;
    installUrl?: string;
    canManage: boolean;
  }

  let page = $state<Page>();
  let failed = $state('');
  let report = $state<StepResult>({ done: [] });
  let install = $state('');
  let build = $state('');
  let test = $state('');
  let address = $state('');
  let admins = $state('');
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function load(first = false) {
    const answer = await get<Page>(`/admin/api/apps/${name}`);
    if ('error' in answer) return (failed = answer.error);
    page = answer;
    if (first) {
      install = answer.build.install ?? '';
      build = answer.build.build ?? '';
      test = answer.build.test ?? '';
      address = answer.app.address;
      admins = answer.admins.join(', ');
    }
    // While a run is queued or running, its steps appear as they happen.
    clearTimeout(timer);
    if (answer.runs.some((r) => r.state === 'queued' || r.state === 'running')) timer = setTimeout(() => load(), 3000);
  }
  load(true);
  onDestroy(() => clearTimeout(timer));

  async function deploy() {
    report = await post(`/admin/api/apps/${name}/deploy`, {});
    if (report.error) return report.error;
    await load();
  }

  async function update() {
    report = await post(`/admin/api/apps/${name}/update`, {});
    if (report.error) return report.error;
    await load();
  }

  async function saveSettings() {
    const commands = { install: install.trim() || undefined, build: build.trim() || undefined, test: test.trim() || undefined };
    report = await post(`/admin/api/apps/${name}/settings`, { build: commands, ...(page?.canManage ? { admins, address: address.trim() } : {}) });
    if (report.error) return report.error;
    await load();
  }

  // A secret is write-only: typed into the dialog, sent once, then cleared; nothing sends it back.
  let secretName = $state<string>();
  let draft = $state('');
  async function submitSecret(): Promise<string | void> {
    const value = draft;
    draft = '';
    if (!value.trim()) return 'Paste the value.';
    const answer = await post(`/admin/api/apps/${name}/secret`, { key: secretName, value });
    if (answer.error) return answer.error;
    report = answer;
    secretName = undefined;
    await load();
  }

  let removing = $state(false);
  let confirm = $state('');
  let data = $state(false);
  async function submitRemove(): Promise<string | void> {
    const answer = await post(`/admin/api/apps/${name}/remove`, { confirm, data });
    if (answer.error) return answer.error;
    removing = false;
    go('/admin');
  }

  const rows = $derived.by(() => {
    if (!page) return [];
    const a = page.app;
    return [
      { key: 'Address', value: `https://${a.address}`, mono: true },
      { key: 'Repo', value: `${a.repo}${a.dir ? `/${a.dir}` : ''}`, mono: true },
      ...(a.source ? [{ key: 'Cloned from', value: `${a.source}, last merged at ${a.sourceRef}`, mono: true }] : []),
      { key: 'Deployed', value: a.deployed ? `${a.deployed.commit.slice(0, 7)}, ${when(a.deployed.at)}` : 'Not yet' },
      ...(a.available ? [{ key: 'Update available', value: `${a.source} ${a.available.ref} (${a.available.commit.slice(0, 7)})` }] : []),
      ...(a.previews.length ? [{ key: 'Previews', value: a.previews.map((p) => `https://pr-${p}.${a.address}`).join('\n'), mono: true }] : []),
      { key: 'Admins', value: page.admins.join(', ') || 'None' },
    ];
  });
</script>

{#if failed}
  <section class="sd-panel"><p class="sd-field-error pad">{failed}</p></section>
{:else if page}
  <PropertyList title={page.app.name} rows={rows}>
    {#snippet actions()}
      {#if page!.app.available}<Button variant="primary" size="sm" icon="refresh-cw" onclick={() => update()}>Update to {page!.app.available.ref}</Button>{/if}
      <Button variant={page!.app.available ? 'secondary' : 'primary'} size="sm" icon="rocket" onclick={() => deploy()}>Deploy now</Button>
      <Button size="sm" icon="link" onclick={() => void window.open(`https://${page!.app.address}`, '_blank', 'noopener')}>Open</Button>
      {#if page!.canManage}<Button size="sm" variant="danger" icon="trash-2" onclick={() => ((confirm = ''), (data = false), (removing = true))}>Remove</Button>{/if}
    {/snippet}
  </PropertyList>

  <Report done={report.done} error={report.error} />

  {#if !page.installed && page.installUrl}
    <section class="sd-panel">
      <div class="sd-stack">
        <p class="body-sm note">The instance's GitHub App is not on this repo, so pushes do not deploy it and pull requests get no previews. Install it on this repo to have both.</p>
        <div><Button variant="secondary" icon="link" onclick={() => void window.open(page!.installUrl, '_blank', 'noopener')}>Install on this repo</Button></div>
      </div>
    </section>
  {/if}

  <section class="sd-panel">
    <div class="sd-panel-head"><h2 class="sd-panel-title">Runs</h2></div>
    {#if !page.runs.length}<p class="sd-list-empty">No runs yet.</p>{/if}
    {#each page.runs as run (run.id)}
      <div class="sd-stack run">
        <div class="row">
          <Badge tone={runTone(run.state)} dot>{runWord(run)}</Badge>
          <span class="mono-sm">{run.ref}{run.commit ? ` (${run.commit.slice(0, 7)})` : ''}</span>
          <span class="body-sm dim">by {run.by}, {when(run.finishedAt ?? run.startedAt ?? run.queuedAt)}</span>
          {#if run.url && run.state === 'done'}<Button size="sm" variant="quiet" icon="link" onclick={() => void window.open(run.url, '_blank', 'noopener')}>Open</Button>{/if}
        </div>
        <Report done={run.done} error={run.error} />
        {#each run.warnings as w}<p class="body-sm warn"><Icon name="circle-help" />{w}</p>{/each}
        {#if run.log?.length}<pre class="mono-sm log">{run.log.join('\n')}</pre>{/if}
      </div>
    {/each}
  </section>

  {#if page.secrets.length}
    <section class="sd-panel">
      <div class="sd-panel-head">
        <h2 class="sd-panel-title">Secrets</h2>
        <p class="sd-panel-sub">What platform.jsonc asks for. Each is kept by the instance and handed to the app's Workers; it is never shown again.</p>
      </div>
      {#each page.secrets as s (s.name)}
        <div class="sd-setting">
          <div class="sd-setting-text"><span class="sd-setting-label mono">{s.name}</span></div>
          <div class="sd-setting-control row">
            <span class="mono">{s.set ? '•••••••• set' : 'Not set'}</span>
            <Button size="sm" onclick={() => ((draft = ''), (secretName = s.name))}>{s.set ? 'Replace' : 'Add'}</Button>
          </div>
        </div>
      {/each}
    </section>
  {/if}

  <section class="sd-panel">
    <div class="sd-panel-head"><h2 class="sd-panel-title">Settings</h2></div>
    <div class="sd-stack">
      {#if page.canManage}<Field label="Address" bind:value={address} mono autocomplete="off" hint="A new address moves the app: its next deploy serves it there, with email from there, and retires the old one." />{/if}
      {#if page.canManage}<Field label="App admins" bind:value={admins} autocomplete="off" hint="They sign in with an emailed code and manage only this app." />{/if}
      <Field label="Install" bind:value={install} mono autocomplete="off" placeholder="Found from the lockfile" />
      <Field label="Build" bind:value={build} mono autocomplete="off" placeholder="The build script, if any" />
      <Field label="Test" bind:value={test} mono autocomplete="off" placeholder="The test script, if any" />
      <div><Button variant="primary" onclick={() => saveSettings()}>Save</Button></div>
    </div>
  </section>
{/if}

{#if secretName}
  <Dialog open title={secretName} description="Kept by the instance and handed to the app on its next deploy. It is never shown again." icon="key-round" onclose={() => (secretName = undefined)} onsubmit={submitSecret}>
    <Field label="Value" bind:value={draft} mono autocomplete="off" />
    {#snippet footer()}
      <Button variant="quiet" onclick={() => (secretName = undefined)}>Cancel</Button>
      <Button variant="primary" type="submit">Save</Button>
    {/snippet}
  </Dialog>
{/if}

{#if removing}
  <Dialog open title={`Remove ${name}`} description="Deletes its Workers, address, previews and sending domain." icon="trash-2" onclose={() => (removing = false)} onsubmit={submitRemove}>
    <Switch bind:checked={data} label="Also delete its database and files; this cannot be undone" />
    <Field label={`Type ${name} to confirm`} bind:value={confirm} mono autocomplete="off" />
    {#snippet footer()}
      <Button variant="quiet" onclick={() => (removing = false)}>Cancel</Button>
      <Button variant="danger" type="submit">Remove</Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .pad { padding: var(--space-4); margin: 0; }
  .note { margin: 0; color: var(--ink-200); }
  .row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .dim { color: var(--ink-300); }
  .warn { display: flex; gap: var(--space-2); margin: 0; color: var(--warning); }
  .run + .run { border-top: 1px solid var(--line-100); }
  .log { margin: 0; padding: var(--space-3); background: var(--bg-000); border-radius: var(--radius-2, 6px); max-height: 320px; overflow: auto; white-space: pre-wrap; color: var(--ink-200); }
</style>
