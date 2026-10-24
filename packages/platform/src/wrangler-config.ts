import type { Config } from "./config.js";

export interface WranglerInput {
  config: Config;
  worker: string;
  hostname: string;
  accountId: string;
  hyperdriveId: string | undefined;
}

export function wranglerConfig({ config, worker, hostname, accountId, hyperdriveId }: WranglerInput): object {
  return {
    name: worker,
    account_id: accountId,
    main: config.worker,
    compatibility_date: config.compatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    routes: [{ pattern: hostname, custom_domain: true }],
    observability: { enabled: true },
    ...(config.frontend && {
      assets: { directory: config.frontend, not_found_handling: "single-page-application", run_worker_first: ["/api/*"] },
    }),
    ...(hyperdriveId && { hyperdrive: [{ binding: "DB", id: hyperdriveId }] }),
  };
}
