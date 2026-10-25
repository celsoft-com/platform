import type { Cloudflare, Registry, Repo } from "../ports.js";
import type { R2S3 } from "./r2.js";

export const REGISTRY_BUCKET = "celsoft-platform";

const key = (app: string) => `apps/${app}.json`;

// One object per app in an account-wide bucket, each naming the repo that deploys it.
export class R2Registry implements Registry {
  private ready: Promise<void> | undefined;

  constructor(
    private readonly s3: R2S3,
    private readonly cloudflare: Cloudflare,
  ) {}

  async get(app: string): Promise<Repo | undefined> {
    if (!(await this.cloudflare.findBucket(REGISTRY_BUCKET))) return undefined;
    const text = await this.s3.get(REGISTRY_BUCKET, key(app));
    return text === undefined ? undefined : (JSON.parse(text) as Repo);
  }

  async claim(app: string, repo: Repo): Promise<boolean> {
    await this.ensureBucket();
    return this.s3.put(REGISTRY_BUCKET, key(app), JSON.stringify(repo), { ifAbsent: true });
  }

  async set(app: string, repo: Repo): Promise<void> {
    await this.ensureBucket();
    await this.s3.put(REGISTRY_BUCKET, key(app), JSON.stringify(repo));
  }

  async release(app: string): Promise<void> {
    if (await this.cloudflare.findBucket(REGISTRY_BUCKET)) await this.s3.delete(REGISTRY_BUCKET, key(app));
  }

  private ensureBucket(): Promise<void> {
    return (this.ready ??= (async () => {
      if (await this.cloudflare.findBucket(REGISTRY_BUCKET)) return;
      // Two first deploys may both try; the loser's create fails, and the bucket exists either way.
      await this.cloudflare.createBucket(REGISTRY_BUCKET).catch(async (error: unknown) => {
        if (!(await this.cloudflare.findBucket(REGISTRY_BUCKET))) throw error;
      });
    })());
  }
}
