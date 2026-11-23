<!-- Adding an app: name its repo, see what it needs, give it a name, an address and its admins. -->
<script lang="ts">
  import { Button, Field, Icon } from './lib/service-dark';
  import Report from './Report.svelte';
  import { post, UPDATES, type StepResult } from './api';

  let { go }: { go: (path: string) => void } = $props();

  interface Inspected {
    repo: { owner: string; name: string; private: boolean; defaultBranch: string };
    installed: boolean;
    installUrl?: string;
    needs: string[];
    warnings: string[];
    zones: string[];
    name: string;
    release?: string;
    updates: 'push' | 'releases' | 'branch';
  }

  let repo = $state('');
  let dir = $state('');
  let found = $state<Inspected>();
  let readError = $state('');
  let name = $state('');
  let address = $state('');
  let admins = $state('');
  let updates = $state<string>('branch');
  let install = $state('');
  let build = $state('');
  let test = $state('');
  let report = $state<StepResult>({ done: [] });

  async function read() {
    readError = '';
    const answer = await post<Inspected & StepResult>('/admin/api/apps/inspect', { repo, dir });
    if (answer.error) {
      found = undefined;
      return (readError = answer.error);
    }
    const first = !found;
    found = answer;
    if (first || !name) name = answer.name;
    if (first) updates = answer.updates;
  }

  async function add() {
    const commands = Object.fromEntries(Object.entries({ install, build, test }).filter(([, v]) => v.trim()));
    report = await post<StepResult & { name?: string }>('/admin/api/apps/add', { repo, dir, name, address, admins, updates, build: commands });
    if (report.error) return report.error;
    go(`/admin/apps/${name}`);
  }
</script>

<section class="sd-panel">
  <div class="sd-panel-head"><h2 class="sd-panel-title">Add an app</h2></div>
  <div class="sd-stack">
    <p class="body intro">An app is a GitHub repo with a platform.jsonc. The instance reads it, then builds and deploys it, and makes everything it needs.</p>
    <Field label="GitHub repo" bind:value={repo} mono autocomplete="off" placeholder="celsoft-com/pages" />
    <Field label="Folder" bind:value={dir} mono autocomplete="off" hint="Only if the app is not at the repo's root." />
    <div><Button variant="secondary" onclick={() => read()}>{found ? 'Read again' : 'Read repo'}</Button></div>
    {#if readError}<p class="sd-field-error">{readError}</p>{/if}
  </div>
</section>

{#if found}
  <section class="sd-panel">
    <div class="sd-panel-head">
      <h2 class="sd-panel-title">{found.repo.owner}/{found.repo.name}</h2>
      <p class="sd-panel-sub">{found.repo.private ? 'Private' : 'Public'}, default branch {found.repo.defaultBranch}{found.release ? `, latest release ${found.release}` : ''}</p>
    </div>
    <div class="sd-stack">
      <div>
        <p class="label">What it needs</p>
        <ul class="body-sm list">{#each found.needs as need}<li><span class="ok"><Icon name="check" /></span>{need}</li>{/each}</ul>
      </div>
      {#each found.warnings as warning}<p class="body-sm warn">{warning}</p>{/each}
      {#if found.installed}
        <p class="body-sm"><span class="ok"><Icon name="check" /></span> The instance's GitHub App is installed on this repo: pushes can deploy it and pull requests get previews.</p>
      {:else if found.installUrl}
        <p class="body-sm note">The instance's GitHub App is not on this repo. Install it on this repo alone to deploy on every push and get previews for pull requests; without it, the app deploys releases or follows the default branch.</p>
        <div class="row">
          <Button variant="secondary" icon="link" onclick={() => void window.open(found!.installUrl, '_blank', 'noopener')}>Install on this repo</Button>
          <Button variant="quiet" icon="refresh-cw" onclick={() => read()}>Check again</Button>
        </div>
      {/if}
    </div>
  </section>

  <section class="sd-panel">
    <div class="sd-panel-head"><h2 class="sd-panel-title">The app</h2></div>
    <div class="sd-stack">
      <Field label="Name" bind:value={name} mono autocomplete="off" hint="Names its Worker, database and files in this account; it cannot change later." />
      <Field label="Address" bind:value={address} mono autocomplete="off" placeholder={`${name || 'app'}.${found.zones[0] ?? 'example.com'}`} hint={found.zones.length ? `A domain or subdomain of ${found.zones.join(', ')}.` : 'The account has no domains yet; add one to Cloudflare first.'} />
      <Field label="App admins" bind:value={admins} autocomplete="off" placeholder="sam@example.com, kim@example.com" hint="They sign in here with an emailed code, and manage only this app." />
      <div class="sd-field">
        <label class="sd-field-label" for="updates">Updates</label>
        <div class="sd-select-wrap">
          <select id="updates" class="sd-input sd-select" bind:value={updates}>
            {#each UPDATES as u}<option value={u.id} disabled={u.id === 'push' && !found.installed}>{u.label}</option>{/each}
          </select>
          <Icon name="chevron-down" />
        </div>
        <span class="sd-field-hint">{UPDATES.find((u) => u.id === updates)?.note}</span>
      </div>
    </div>
  </section>

  <section class="sd-panel">
    <div class="sd-panel-head">
      <h2 class="sd-panel-title">Build</h2>
      <p class="sd-panel-sub">Left empty, each is found from the repo: install by its lockfile, then its build and test scripts.</p>
    </div>
    <div class="sd-stack">
      <Field label="Install" bind:value={install} mono autocomplete="off" placeholder="npm ci" />
      <Field label="Build" bind:value={build} mono autocomplete="off" placeholder="npm run build" />
      <Field label="Test" bind:value={test} mono autocomplete="off" placeholder="npm run test" />
      <Report done={report.done} error={report.error} />
      <div class="row">
        <Button variant="primary" icon="rocket" onclick={() => add()}>Add and deploy</Button>
        <Button variant="quiet" onclick={() => go('/admin')}>Cancel</Button>
      </div>
    </div>
  </section>
{/if}

<style>
  .intro, .note { margin: 0; color: var(--ink-200); }
  .warn { margin: 0; color: var(--warning); }
  .list { list-style: none; margin: var(--space-2) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-1); }
  .list li { display: flex; gap: var(--space-2); }
  .ok { color: var(--success); }
  .row { display: flex; gap: var(--space-3); flex-wrap: wrap; }
  p.body-sm { display: flex; gap: var(--space-2); margin: 0; }
</style>
