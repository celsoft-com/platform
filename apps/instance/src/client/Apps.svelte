<!-- Every app the viewer may see, with how its latest run went. -->
<script lang="ts">
  import { Badge, Button } from './lib/service-dark';
  import { get, type AppRow } from './api';
  import { runTone, runWord } from './runs';

  let { go }: { go: (path: string) => void } = $props();

  let apps = $state<AppRow[]>();
  let canAdd = $state(false);
  let failed = $state('');

  async function load() {
    const answer = await get<{ apps: AppRow[]; canAdd: boolean }>('/admin/api/apps');
    if ('error' in answer) return (failed = answer.error);
    apps = answer.apps;
    canAdd = answer.canAdd;
  }
  load();
</script>

<section class="sd-panel">
  <div class="sd-panel-head head">
    <h2 class="sd-panel-title">Apps</h2>
    {#if canAdd}<Button variant="primary" size="sm" icon="plus" onclick={() => go('/admin/apps/new')}>Add app</Button>{/if}
  </div>
  {#if failed}
    <p class="sd-field-error pad">{failed}</p>
  {:else if apps && !apps.length}
    <p class="sd-list-empty">{canAdd ? 'No apps yet. Add one from its GitHub repo.' : 'No apps name you as an admin yet.'}</p>
  {:else}
    {#each apps ?? [] as app (app.name)}
      <div class="sd-setting">
        <div class="sd-setting-text">
          <span class="sd-setting-label">{app.name}</span>
          <span class="sd-setting-desc mono-sm">{app.address} · {app.repo}{app.dir ? `/${app.dir}` : ''}</span>
        </div>
        <div class="sd-setting-control row">
          {#if app.available}<Badge tone="info">Update available</Badge>{/if}
          {#if app.last}<Badge tone={runTone(app.last.state)} dot>{runWord(app.last)}</Badge>{:else}<Badge>Not deployed</Badge>{/if}
          <Button size="sm" icon="chevron-right" onclick={() => go(`/admin/apps/${app.name}`)}>Open</Button>
        </div>
      </div>
    {/each}
  {/if}
</section>

<style>
  .head { display: flex; align-items: center; justify-content: space-between; }
  .row { display: flex; align-items: center; gap: var(--space-3); }
  .pad { padding: var(--space-4); margin: 0; }
</style>
