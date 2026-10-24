import { spawn } from "node:child_process";
import type { GitHub } from "../ports.js";

export class GhCli implements GitHub {
  constructor(private readonly repoRoot: string) {}

  async setSecret(name: string, value: string): Promise<void> {
    await this.gh(["secret", "set", name], value);
  }

  async ensureEnvironment(name: string): Promise<void> {
    const repo = (await this.gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
    await this.gh(["api", "--method", "PUT", `repos/${repo}/environments/${name}`, "--silent"]);
  }

  private gh(args: string[], stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("gh", args, { cwd: this.repoRoot, stdio: ["pipe", "pipe", "inherit"] });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.on("error", (error) => reject(new Error(`could not run gh, the GitHub CLI (${error.message}); install it and run \`gh auth login\``)));
      child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`gh ${args[0]} ${args[1]} exited with code ${code}`))));
      child.stdin.end(stdin ?? "");
    });
  }
}

const MARKER = "<!-- platform-preview -->";

export async function commentPreviewLink(env: NodeJS.ProcessEnv, pr: number, url: string): Promise<void> {
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  if (!token || !repo) return;

  const api = (path: string, init?: RequestInit) =>
    fetch(`https://api.github.com/repos/${repo}/${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
    });

  const body = `${MARKER}\nPreview: ${url}\n\nCommit ${env.GITHUB_SHA?.slice(0, 7) ?? ""}`;
  const comments = (await (await api(`issues/${pr}/comments?per_page=100`)).json()) as { id: number; body?: string }[];
  const existing = comments.find((c) => c.body?.startsWith(MARKER));
  const response = existing
    ? await api(`issues/comments/${existing.id}`, { method: "PATCH", body: JSON.stringify({ body }) })
    : await api(`issues/${pr}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  if (!response.ok) throw new Error(`could not comment the preview link on PR ${pr}: ${response.status}`);
}
