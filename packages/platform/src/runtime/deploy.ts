export type DeployTarget = "prod" | "preview" | "dev" | "test";

// What this Worker was built from, which the deploy, `dev` and testApp set; null where unknown.
export interface Deploy {
  commit: string | null;
  branch: string | null;
  builtAt: Date | null;
  target: DeployTarget | null;
}

export interface DeployBindings {
  PLATFORM_COMMIT?: string;
  PLATFORM_BRANCH?: string;
  PLATFORM_BUILT_AT?: string;
  PLATFORM_TARGET?: string;
}

const TARGETS: readonly string[] = ["prod", "preview", "dev", "test"];

export function readDeploy(env: DeployBindings): Deploy {
  const at = env.PLATFORM_BUILT_AT ? new Date(env.PLATFORM_BUILT_AT) : null;
  return {
    commit: env.PLATFORM_COMMIT || null,
    branch: env.PLATFORM_BRANCH || null,
    builtAt: at && !Number.isNaN(at.getTime()) ? at : null,
    target: env.PLATFORM_TARGET && TARGETS.includes(env.PLATFORM_TARGET) ? (env.PLATFORM_TARGET as DeployTarget) : null,
  };
}
