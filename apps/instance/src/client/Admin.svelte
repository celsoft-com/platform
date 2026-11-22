<!-- Signed in: the super admin's two setup steps, then the admin interface; a platform admin sees Apps only. -->
<script lang="ts">
  import { Button, Dialog, Field, Settings, Sidebar } from './lib/service-dark';
  import type { SettingsPage } from './lib/service-dark/components/Settings.svelte';
  import Report from './Report.svelte';
  import { InstanceSettings } from './settings';
  import { get, post, type Build, type StepResult } from './api';

  interface State {
    build: Build;
    viewer: { email: string; role: 'super' | 'platform' };
    setup?: { token: boolean; tokenWorks: boolean; github?: { slug: string; owner: string } };
    settings?: InstanceSettings;
    configured?: Record<string, boolean>;
    tokenUrl?: string;
    permissions?: string[];
  }

  let { path, onbuild }: { path: string; onbuild: (build: Build) => void } = $props();

  let state = $state<State>();
  let failed = $state('');
  let report = $state<StepResult>({ done: [] });
  let token = $state('');
  let owner = $state('');
  let active = $state('apps');
  let category = $state('cloudflare');
  let settings = $state<InstanceSettings>();

  async function load() {
    const answer = await get<State>('/admin/api/state');
    if ('error' in answer) return (failed = answer.error);
    state = answer;
    onbuild(answer.build);
    if (answer.settings) settings = InstanceSettings.parse(answer.settings);
  }

  // GitHub sends the super admin back here after creating or installing the app.
  async function returned() {
    const params = new URLSearchParams(location.search);
    if (path === '/admin/github/created') report = await post('/admin/api/github/created', { code: params.get('code'), state: params.get('state') });
    if (path === '/admin/github/installed') report = await post('/admin/api/github/installed', {});
    if (path !== '/admin') history.replaceState(null, '', '/admin');
    await load();
  }
  returned();

  const needsToken = $derived(state?.setup && (!state.setup.token || !state.setup.tokenWorks));
  const needsGithub = $derived(state?.setup && !needsToken && !state.setup.github);

  async function saveToken() {
    report = await post('/admin/api/token', { token });
    if (report.error) return report.error;
    token = '';
    await load();
  }

  // GitHub creates an app from a manifest posted by the browser, so this posts it.
  async function createApp() {
    const answer = await post<{ action: string; manifest: string }>('/admin/api/github/start', { owner });
    if (answer.error) return answer.error;
    const form = Object.assign(document.createElement('form'), { method: 'post', action: answer.action });
    form.append(Object.assign(document.createElement('input'), { type: 'hidden', name: 'manifest', value: answer.manifest }));
    document.body.append(form);
    form.submit();
  }

  async function save({ category, changes }: { category: string; changes: Record<string, unknown> }) {
    const result = await post('/admin/api/settings', { category, changes });
    if (result.error) return result.error;
    await load();
  }

  // A key is write-only: typed into the dialog, sent once to the Worker, and never shown or sent back.
  async function change({ path, value }: { path: string; value: unknown }) {
    const [category, key] = path.split('.');
    return save({ category: category!, changes: { [key!]: value } });
  }

  // Where each key is made: Cloudflare's token page with every permission filled in, and the other services' key pages.
  const makers: Record<string, { label: string; url: () => string | undefined; note?: () => string[] | undefined }> = {
    token: { label: 'Create token', url: () => state?.tokenUrl, note: () => state?.permissions },
    neonKey: { label: 'Open Neon', url: () => 'https://console.neon.tech' },
    resendKey: { label: 'Open Resend API keys', url: () => 'https://resend.com/api-keys' },
  };
  const open = (url: string | undefined) => void window.open(url, '_blank', 'noopener');

  let replacing = $state<{ page: SettingsPage; key: string; title: string }>();
  let draft = $state('');

  function replace(page: SettingsPage, key: string, title: string) {
    draft = '';
    replacing = { page, key, title };
  }

  async function submitKey(): Promise<string | void | false> {
    if (!replacing) return;
    const error = await replacing.page.set(replacing.key, draft.trim());
    draft = '';
    if (error) return error;
    replacing = undefined;
  }
</script>

{#if failed || !state}
  <main class="page">
    <section class="sd-panel card">
      {#if failed}
        <p class="body">{failed}</p>
        <Button variant="primary" onclick={() => location.reload()}>Sign in</Button>
      {/if}
    </section>
  </main>
{:else if needsToken}
  <main class="page">
    <section class="sd-panel card">
      <p class="label step">Setup, step 1 of 2</p>
      <h1 class="display">{state.setup?.token ? 'Replace the token' : 'Give the instance its token'}</h1>
      <p class="body intro">
        {state.setup?.token
          ? "The instance's Cloudflare token stopped working: it was revoked, expired or deleted. Create a new one and paste it here."
          : 'Deploying apps needs more than claiming did. Create a token with these permissions, the zone ones on all zones; it replaces the setup token.'}
      </p>
      <ul class="body-sm permissions">{#each state.permissions ?? [] as p}<li>{p}</li>{/each}</ul>
      <Button variant="secondary" icon="key-round" onclick={() => void window.open(state!.tokenUrl, '_blank', 'noopener')}>Create token</Button>
      <Field label="Token" bind:value={token} mono autocomplete="off" hint="If Cloudflare's page says it could not add a permission, add it there by hand." />
      <Report done={report.done} error={report.error} />
      <Button variant="primary" block onclick={() => saveToken()}>Check and save</Button>
    </section>
  </main>
{:else if needsGithub}
  <main class="page">
    <section class="sd-panel card">
      <p class="label step">Setup, step 2 of 2</p>
      <h1 class="display">Create the GitHub App</h1>
      <p class="body intro">The instance gets its own private GitHub App, which reads app repos and hears their pushes and pull requests. A private app can only be installed where it belongs, so name the org your app repos live in, or leave it empty if they are in your own account.</p>
      <Field label="GitHub org where your app repos live" bind:value={owner} mono autocomplete="off" placeholder="celsoft-com" />
      <Report done={report.done} error={report.error} />
      <Button variant="primary" block onclick={() => createApp()}>Create on GitHub</Button>
    </section>
  </main>
{:else}
  <div class="shell">
    <Sidebar
      product="Platform"
      groups={[{ items: [{ id: 'apps', label: 'Apps', icon: 'box' }, ...(state.viewer.role === 'super' ? [{ id: 'settings', label: 'Settings', icon: 'settings' }] : [])] }]}
      footer={[{ id: 'signout', label: 'Sign out', icon: 'log-out', href: '/cdn-cgi/access/logout' }]}
      bind:active
      storageKey="platform-sidebar-width"
    />
    <main class="content">
      <header class="topbar">
        <h1 class="title">{active === 'settings' ? 'Settings' : 'Apps'}</h1>
        <span class="body-sm who">{state.viewer.email}, {state.viewer.role === 'super' ? 'super admin' : 'platform admin'}</span>
      </header>
      <div class="body-area">
        <Report done={report.done} error={report.error} />
        {#if active === 'settings' && settings}
          <Settings
            schema={InstanceSettings}
            bind:value={settings}
            bind:category
            label="Instance settings"
            onchange={change}
            onsave={save}
            pages={{ cloudflare: keyPage, database: keyPage, email: keyPage }}
          />
        {:else}
          <section class="sd-panel">
            <div class="sd-panel-head"><h2 class="sd-panel-title">Apps</h2></div>
            <p class="sd-list-empty">No apps yet. Adding apps comes in a later version.</p>
          </section>
        {/if}
      </div>
    </main>
  </div>
{/if}

{#snippet keyPage(page: SettingsPage)}
  {#each page.settings as s (s.key)}
    {@const set = state?.configured?.[s.key]}
    <div class="sd-setting">
      <div class="sd-setting-text">
        <span class="sd-setting-label">{s.title}</span>
        {#if s.description}<span class="sd-setting-desc">{s.description}</span>{/if}
      </div>
      <div class="sd-setting-control key">
        <span class="mono">{set ? '•••••••• set' : 'Not set'}</span>
        <Button size="sm" variant="quiet" icon="link" onclick={() => open(makers[s.key]?.url())}>{makers[s.key]?.label}</Button>
        <Button size="sm" onclick={() => replace(page, s.key, s.title)}>{set ? 'Replace' : 'Add'}</Button>
      </div>
      {#if page.errors[s.key]}<span class="sd-field-error">{page.errors[s.key]}</span>{/if}
    </div>
  {/each}
{/snippet}

{#if replacing}
  <Dialog open title={replacing.title} description="It is checked, then kept as this instance's secret. It is never shown again." icon="key-round" onclose={() => (replacing = undefined)} onsubmit={submitKey}>
    {@const maker = makers[replacing.key]}
    {#if maker?.note?.()}<ul class="body-sm permissions">{#each maker.note() ?? [] as p}<li>{p}</li>{/each}</ul>{/if}
    {#if maker}<Button variant="secondary" icon="link" onclick={() => open(maker.url())}>{maker.label}</Button>{/if}
    <Field label={replacing.title} bind:value={draft} mono autocomplete="off" />
    {#snippet footer()}
      <Button variant="quiet" onclick={() => (replacing = undefined)}>Cancel</Button>
      <Button variant="primary" type="submit">Check and save</Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .key { display: flex; align-items: center; gap: var(--space-3); }
  .page { min-height: 100vh; display: grid; place-items: center; padding: var(--space-6) var(--space-4); box-sizing: border-box; }
  .card { width: 100%; max-width: 480px; padding: var(--space-6); display: flex; flex-direction: column; gap: var(--space-4); box-shadow: var(--shadow-pop); }
  h1, .intro, .step { margin: 0; }
  .intro { color: var(--ink-200); }
  .step { color: var(--ink-300); }
  .permissions { margin: 0; padding-left: var(--space-4); color: var(--ink-200); }
  .shell { display: flex; height: 100vh; }
  .content { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--bg-100); }
  .topbar { height: var(--topbar-height); display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); padding: 0 var(--space-6); border-bottom: 1px solid var(--line-100); }
  .topbar h1 { margin: 0; }
  .who { color: var(--ink-300); }
  .body-area { flex: 1; min-height: 0; overflow: auto; padding: var(--space-6); display: flex; flex-direction: column; gap: var(--space-6); max-width: 1080px; width: 100%; box-sizing: border-box; }
</style>
