<!-- Claiming the instance: reserve it with a token and an email, then sign in as that email. Also /reset. -->
<script lang="ts">
  import { Button, Field } from './lib/service-dark';
  import Report from './Report.svelte';
  import { get, post, type Build } from './api';

  interface State {
    build: Build;
    stage: 'unclaimed' | 'reserved' | 'claimed';
    reserved?: string;
    tokenUrl: string;
    permissions: string[];
  }

  let { resetting, onbuild }: { resetting: boolean; onbuild: (build: Build) => void } = $props();

  let state = $state<State>();
  let failed = $state('');
  let token = $state('');
  let email = $state('');
  let done = $state<string[]>([]);
  let error = $state('');
  let replacing = $state(false);

  async function load() {
    const answer = await get<State>('/api/state');
    if ('error' in answer) return (failed = answer.error);
    state = answer;
    onbuild(answer.build);
    if (state.stage !== 'claimed' && resetting) location.href = '/';
  }
  load();

  async function reserve() {
    const result = await post(resetting ? '/api/reset' : '/api/reserve', { token, email });
    done = result.done ?? [];
    error = result.error ?? '';
    if (error) return error;
    token = '';
    replacing = false;
    await load();
  }
</script>

<main class="page">
  <section class="sd-panel card">
    {#if failed}
      <p class="sd-field-error">{failed}</p>
    {:else if state}
      {#if state.stage === 'claimed' && !resetting}
        <h1 class="display">Platform</h1>
        <p class="body intro">This instance is set up. Sign in with the code Cloudflare emails you.</p>
        <Button variant="primary" block onclick={() => (location.href = '/admin')}>Sign in</Button>
        <Button variant="quiet" block onclick={() => (location.href = '/reset')}>Lost access to your sign-in email?</Button>
      {:else if state.stage === 'reserved' && !replacing}
        <h1 class="display">One step left: sign in</h1>
        <p class="body intro">Sign in as <strong>{state.reserved}</strong>, the email you entered. Cloudflare emails a code to that address; enter it on Cloudflare's sign-in page and you become the super admin.</p>
        <Report {done} />
        <Button variant="primary" block onclick={() => (location.href = '/admin')}>Sign in as {state.reserved}</Button>
        <Button variant="quiet" block onclick={() => (replacing = true)}>Wrong email, or no code arriving?</Button>
      {:else}
        <h1 class="display">{resetting ? 'Reset the super admin' : state.stage === 'reserved' ? 'Replace the reservation' : 'Set up this instance'}</h1>
        <p class="body intro">
          {resetting
            ? 'For a super admin who lost their email: a token for this Cloudflare account and a new email reserve the instance again for that email.'
            : 'Paste a token for this Cloudflare account and your email. You become the super admin once you sign in with the code Cloudflare emails you.'}
        </p>
        <div class="body-sm permissions">
          <p class="label">The token needs</p>
          <ul>{#each state.permissions as p}<li>{p}</li>{/each}</ul>
        </div>
        <Button variant="secondary" icon="key-round" onclick={() => void window.open(state!.tokenUrl, '_blank', 'noopener')}>Create token</Button>
        <Field label="Token" bind:value={token} mono autocomplete="off" hint="The token named platform setup, not the build token Cloudflare made for this Worker." />
        <Field label="Your email" type="email" bind:value={email} autocomplete="email" />
        <Report {done} {error} />
        <Button variant="primary" block onclick={() => reserve()}>{resetting ? 'Reset' : 'Reserve'}</Button>
        {#if replacing}<Button variant="quiet" block onclick={() => (replacing = false)}>Back</Button>{/if}
        {#if resetting}<Button variant="quiet" block onclick={() => (location.href = '/')}>Back</Button>{/if}
      {/if}
    {/if}
  </section>
</main>

<style>
  .page { min-height: 100vh; display: grid; place-items: center; padding: var(--space-6) var(--space-4); box-sizing: border-box; }
  .card { width: 100%; max-width: 440px; padding: var(--space-6); display: flex; flex-direction: column; gap: var(--space-4); box-shadow: var(--shadow-pop); }
  h1, .intro { margin: 0; }
  .intro { color: var(--ink-200); }
  .permissions p { margin: 0 0 var(--space-1); color: var(--ink-300); }
  .permissions ul { margin: 0; padding-left: var(--space-4); color: var(--ink-200); }
</style>
