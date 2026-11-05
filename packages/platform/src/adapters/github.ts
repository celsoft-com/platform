import { spawn } from "node:child_process";
import type { GitHub, Repo } from "../ports.js";

export class GhCli implements GitHub {
  private resolved: Promise<string> | undefined;

  constructor(
    private readonly repoRoot: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  // Named on every call, never left to gh: with a second remote, such as the template a site was
  // copied from, gh's default could be the other repo, and its secrets would get this app's tokens.
  target(): Promise<string> {
    return (this.resolved ??= this.env.GITHUB_REPOSITORY ? Promise.resolve(this.env.GITHUB_REPOSITORY) : this.fromRemotes());
  }

  async setSecret(name: string, value: string): Promise<void> {
    await this.gh(["secret", "set", name, "-R", await this.target()], value);
  }

  async ensureEnvironment(name: string): Promise<void> {
    await this.gh(["api", "--method", "PUT", `repos/${await this.target()}/environments/${name}`, "--silent"]);
  }

  async openPullRequests(): Promise<number[]> {
    const out = await this.gh(["pr", "list", "-R", await this.target(), "--state", "open", "--limit", "1000", "--json", "number", "--jq", ".[].number"]);
    return out.split("\n").filter(Boolean).map(Number);
  }

  // The REST API gives the numeric id Actions also uses.
  async repository(): Promise<Repo> {
    return JSON.parse(await this.gh(["api", `repos/${await this.target()}`, "--jq", "{id, name: .full_name}"])) as Repo;
  }

  // origin, else the only remote; the path gives owner/name whatever host or SSH alias the URL uses.
  private async fromRemotes(): Promise<string> {
    const remotes = (await this.run("git", ["remote"])).split("\n").filter(Boolean);
    const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0]! : undefined;
    if (!remote) throw new Error(`cannot tell which GitHub repo this app is: ${remotes.length ? `remotes ${remotes.join(", ")} and none is origin` : "no git remote"}; name the app's own repo's remote origin`);
    return repoFromUrl((await this.run("git", ["remote", "get-url", remote])).trim());
  }

  private gh(args: string[], stdin?: string): Promise<string> {
    return this.run("gh", args, stdin).catch((error: Error & { code?: string }) => {
      throw error.code === "ENOENT" ? new Error(`could not run gh, the GitHub CLI (${error.message}); install it and run \`gh auth login\``) : error;
    });
  }

  private run(command: string, args: string[], stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: this.repoRoot, stdio: ["pipe", "pipe", "inherit"] });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${command} ${args[0]} ${args[1]} exited with code ${code}`))));
      child.stdin.end(stdin ?? "");
    });
  }
}

export function repoFromUrl(url: string): string {
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) throw new Error(`cannot read a GitHub owner/name from the remote ${url}`);
  return `${match[1]}/${match[2]}`;
}

const MARKER = "<!-- platform-preview -->";

export async function commentPreviewLink(env: NodeJS.ProcessEnv, pr: number, url: string, sha?: string): Promise<void> {
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  if (!token || !repo) return;

  const api = (path: string, init?: RequestInit) =>
    fetch(`https://api.github.com/repos/${repo}/${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
    });

  const body = `${MARKER}\nPreview: ${url}\n\nCommit ${(sha ?? env.GITHUB_SHA)?.slice(0, 7) ?? ""}`;
  const comments = (await (await api(`issues/${pr}/comments?per_page=100`)).json()) as { id: number; body?: string }[];
  const existing = comments.find((c) => c.body?.startsWith(MARKER));
  const response = existing
    ? await api(`issues/comments/${existing.id}`, { method: "PATCH", body: JSON.stringify({ body }) })
    : await api(`issues/${pr}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  if (!response.ok) throw new Error(`could not comment the preview link on PR ${pr}: ${response.status}`);
}
