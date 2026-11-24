<!-- Signed in: the super admin's two setup steps, then the admin interface; a platform admin sees Apps only. -->
<script lang="ts">
  import { Button, Dialog, Field, Settings, Sidebar } from './lib/service-dark';
  import type { SettingsPage } from './lib/service-dark/components/Settings.svelte';
  import Report from './Report.svelte';
  import Apps from './Apps.svelte';
  import AddApp from './AddApp.svelte';
  import AppPage from './AppPage.svelte';
  import { InstanceSettings } from './settings';
  import { get, post, type Build, type StepResult } from './api';

  interface State {
    build: Build;
    viewer: { email: string; role: 'super' | 'platform' | 'app' };
    setup?: { token: boolean; tokenWorks: boolean; github?: { slug: string; owner: string } };
    settings?: InstanceSettings;
    configured?: Record<string, boolean>;
    tokenUrl?: string;
    permissions?: string[];
    instance?: Instance;
  }

  interface Instance {
    repo: string;
    suggested: string;
    source: string;
    merged?: { ref: string; commit: string };
    available?: { ref: string; commit: string };
    github: {
      callback: string;
      check?: { error: string } | { app: string[]; installation: string[]; installed: boolean; settings: string; installationUrl?: string };
    };
  }

  let { path, onbuild }: { path: string; onbuild: (build: Build) => void } = $props();

  let state = $state<State>();
  let failed = $state('');
  let report = $state<StepResult>({ done: [] });
  let token = $state('');
  let owner = $state('');
  let active = $state('apps');
  // Which apps page shows: the list, Add app, or one app's page, kept in the address so it survives a reload.
  let current = $state(path);
  const appName = $derived(/^\/admin\/apps\/([^/]+)$/.exec(current)?.[1]);
  function go(to: string) {
    history.pushState(null, '', to);
    current = to;
    active = 'apps';
    report = { done: [] };
  }
  addEventListener('popstate', () => (current = location.pathname));
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
    if (path === '/admin/github/authorized' && params.get('error')) report = { done: [], error: `GitHub did not let the instance make the repo: ${params.get('error_description') ?? params.get('error')}.` };
    else if (path === '/admin/github/authorized') {
      // GitHub's answer to Add app: the instance makes the app's repo and queues its first run.
      const answer = await post<StepResult & { name?: string }>('/admin/api/apps/authorized', { code: params.get('code'), state: params.get('state') });
      if (answer.name && !answer.error) {
        history.replaceState(null, '', `/admin/apps/${answer.name}`);
        current = `/admin/apps/${answer.name}`;
        return load();
      }
      report = answer;
    }
    if (path.startsWith('/admin/github/')) {
      history.replaceState(null, '', '/admin');
      current = '/admin';
    }
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

  // Where each key is made: Cloudflare's token page with every permission filled in, and the other services' key pages.
  const makers: Record<string, { label: string; url: () => string | undefined; note?: () => string[] | undefined }> = {
    token: { label: 'Create token', url: () => state?.tokenUrl, note: () => state?.permissions },
    neonKey: { label: 'Open Neon', url: () => 'https://console.neon.tech' },
    resendKey: { label: 'Open Resend API keys', url: () => 'https://resend.com/api-keys' },
  };
  const open = (url: string | undefined) => void window.open(url, '_blank', 'noopener');

  // The instance's own repo and its updates, on the GitHub page of Settings.
  let instanceRepo = $state('');
  let githubReport = $state<StepResult>({ done: [] });
  $effect(() => {
    if (state?.instance && !instanceRepo) instanceRepo = state.instance.repo || state.instance.suggested;
  });
  async function saveRepo() {
    githubReport = await post('/admin/api/instance/repo', { repo: instanceRepo });
    if (!githubReport.error) await load();
  }
  async function updateInstance() {
    githubReport = { done: ['Merging; this takes a minute.'] };
    githubReport = await post('/admin/api/instance/update', {});
    if (!githubReport.error) await load();
  }

  // A key is write-only: typed into the dialog, sent once straight to the Worker, then cleared. It never
  // enters Settings' values, and nothing ever sends it back.
  let replacing = $state<{ category: string; key: string; title: string }>();
  let draft = $state('');

  function replace(page: SettingsPage, key: string, title: string) {
    draft = '';
    replacing = { category: page.category, key, title };
  }

  async function submitKey(): Promise<string | void | false> {
    if (!replacing) return;
    const sent = draft.trim();
    draft = '';
    if (!sent) return 'Paste the new key.';
    const error = await save({ category: replacing.category, changes: { [replacing.key]: sent } });
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
      <p class="body intro">The instance gets its own private GitHub App, which makes each app's repo, merges updates into it, and hears its pushes and pull requests. A private app can only be installed where it belongs, so name the org your app repos live in, or leave it empty if they are in your own account.</p>
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
      onselect={(id: string) => id === 'apps' && go('/admin')}
      storageKey="platform-sidebar-width"
    />
    <main class="content">
      <header class="topbar">
        <h1 class="title">{active === 'settings' ? 'Settings' : 'Apps'}</h1>
        <span class="body-sm who">{state.viewer.email}, {{ super: 'super admin', platform: 'platform admin', app: 'app admin' }[state.viewer.role]}</span>
      </header>
      <div class="body-area">
        <Report done={report.done} error={report.error} />
        {#if active === 'settings' && settings}
          <Settings
            schema={InstanceSettings}
            bind:value={settings}
            bind:category
            label="Instance settings"
            onsave={save}
            pages={{ cloudflare: keyPage, github: githubPage, database: keyPage, email: keyPage }}
          />
        {:else if current === '/admin/apps/new'}
          <AddApp {go} />
        {:else if appName}
          {#key appName}<AppPage name={appName} {go} />{/key}
        {:else}
          <Apps {go} />
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

{#snippet githubPage(page: SettingsPage)}
  {@const inst = state?.instance}
  {@const check = inst?.github.check}
  {#each page.settings as s (s.key)}
    <div class="sd-setting">
      <div class="sd-setting-text">
        <span class="sd-setting-label">{s.title}</span>
        {#if s.description}<span class="sd-setting-desc">{s.description}</span>{/if}
      </div>
      <div class="sd-setting-control"><span class="mono">{settings?.github[s.key as 'app' | 'owner']}</span></div>
    </div>
  {/each}
  {#if inst}
    <div class="sd-setting">
      <div class="sd-setting-text">
        <span class="sd-setting-label">What the app may do</span>
        {#if check && 'error' in check}
          <span class="sd-field-error">{check.error}</span>
        {:else if check && (check.app.length || check.installation.length || !check.installed)}
          <span class="sd-setting-desc">Making each app's repo and merging updates needs more than the app has. In its settings, give it {[...new Set([...check.app, ...check.installation])].join(', ')}, and set its Callback URL to <span class="mono">{inst.github.callback}</span>; then accept the new permissions where it is installed.</span>
        {:else}
          <span class="sd-setting-desc">Everything it needs. Its Callback URL must be <span class="mono">{inst.github.callback}</span>.</span>
        {/if}
      </div>
      <div class="sd-setting-control key">
        {#if check && !('error' in check)}
          <Button size="sm" variant="quiet" icon="link" onclick={() => open(check.settings)}>App settings</Button>
          {#if check.installationUrl}<Button size="sm" variant="quiet" icon="link" onclick={() => open(check.installationUrl)}>Installation</Button>{/if}
        {/if}
      </div>
    </div>
    <div class="sd-setting">
      <div class="sd-setting-text">
        <span class="sd-setting-label">This instance's repo</span>
        <span class="sd-setting-desc">The repo Deploy to Cloudflare made, which Cloudflare deploys. Update merges {inst.source}'s newer versions into it.</span>
      </div>
      <div class="sd-setting-control key">
        <Field label="Repo" bind:value={instanceRepo} mono autocomplete="off" />
        <Button size="sm" onclick={() => saveRepo()}>Save</Button>
      </div>
    </div>
    {#if inst.repo}
      <div class="sd-setting">
        <div class="sd-setting-text">
          <span class="sd-setting-label">Version</span>
          <span class="sd-setting-desc">
            {inst.merged ? `${inst.source} ${inst.merged.ref} (${inst.merged.commit.slice(0, 7)})` : `Not updated by this instance yet`}{inst.available ? `; ${inst.available.ref} (${inst.available.commit.slice(0, 7)}) is available` : ''}.
          </span>
        </div>
        <div class="sd-setting-control key">
          <Button size="sm" variant={inst.available ? 'primary' : 'secondary'} icon="refresh-cw" onclick={() => updateInstance()}>{inst.available ? `Update to ${inst.available.ref}` : 'Update now'}</Button>
        </div>
      </div>
    {/if}
    <Report done={githubReport.done} error={githubReport.error} />
  {/if}
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
