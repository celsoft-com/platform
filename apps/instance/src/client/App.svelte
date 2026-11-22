<!-- The instance's pages: claiming at / and /reset, everything else under /admin behind Cloudflare Access. -->
<script lang="ts">
  import { registerIcons } from './lib/service-dark';
  import { Cloud, Database, GitBranch, Mail } from '@lucide/svelte';
  import Claim from './Claim.svelte';
  import Admin from './Admin.svelte';
  import type { Build } from './api';

  registerIcons({ cloud: Cloud, database: Database, 'git-branch': GitBranch, mail: Mail });

  const path = location.pathname;
  let build = $state<Build>();
  const when = $derived(build?.deployedAt ? ` · ${build.deployedAt.slice(0, 16).replace('T', ' ')} UTC` : '');
</script>

{#if path.startsWith('/admin')}
  <Admin {path} onbuild={(b) => (build = b)} />
{:else}
  <Claim resetting={path === '/reset'} onbuild={(b) => (build = b)} />
{/if}

{#if build}<p class="mono-sm build">Build {build.version.slice(0, 8)}{when}</p>{/if}

<style>
  :global(body) {
    margin: 0;
    background: var(--bg-000);
    color: var(--ink-100);
    font-family: var(--font-sans);
  }
  /* Which deploy is serving, so whoever reports a problem can say what they were running. */
  .build {
    position: fixed;
    right: var(--space-3);
    bottom: var(--space-2);
    margin: 0;
    color: var(--ink-300);
  }
</style>
