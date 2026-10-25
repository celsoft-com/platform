// A short, slow, obviously correct version of the access rules in docs/access-rules.md, written
// from the rules rather than the SQL, so randomized tests can hold the real thing to it.

export const MAX_DEPTH = 64;
export const [READ, CREATE, WRITE, DELETE, MANAGE] = [1, 2, 3, 4, 5];

export type Grantee = { user: string } | { team: string } | { organization: string } | { email: string };
export type Outcome = "ok" | 404 | 409;

export interface Item {
  kind: string;
  id: string;
  parentKind: string;
  parentId: string;
  restricted: boolean;
}

export class Reference {
  users = new Map<string, { email: string; verified: boolean }>();
  orgs = new Set<string>();
  roles = new Map<string, string>(); // `${org} ${user}` -> role text, as Better Auth stores it
  teams = new Map<string, string>(); // team -> org
  teamMembers = new Set<string>(); // `${team} ${user}`
  items = new Map<string, Item>(); // `${kind} ${id}`
  grants = new Map<string, { kind: string; id: string; to: Grantee; level: number }>();
  links = new Map<string, { kind: string; id: string; level: number; expired: boolean }>(); // token -> link

  item(kind: string, id: string): Item | undefined {
    return this.items.get(`${kind} ${id}`);
  }

  // The item and everything above it, nearest first; null when it never reaches a user or
  // organization that exists, or is too deep.
  chain(kind: string, id: string): { chain: Item[]; top: { kind: string; id: string } } | null {
    const chain: Item[] = [];
    let node = this.item(kind, id);
    while (node) {
      chain.push(node);
      if (chain.length > MAX_DEPTH) return null;
      if (node.parentKind === "user") return this.users.has(node.parentId) ? { chain, top: { kind: "user", id: node.parentId } } : null;
      if (node.parentKind === "organization") return this.orgs.has(node.parentId) ? { chain, top: { kind: "organization", id: node.parentId } } : null;
      node = this.item(node.parentKind, node.parentId);
    }
    return null;
  }

  roleLevels(org: string, user: string | null): string[] {
    if (!user) return [];
    const role = this.roles.get(`${org} ${user}`);
    return role === undefined ? [] : role.split(",").map((r) => r.trim());
  }

  matches(to: Grantee, user: string | null): boolean {
    if (!user) return false;
    if ("user" in to) return to.user === user;
    if ("team" in to) return this.teamMembers.has(`${to.team} ${user}`);
    if ("organization" in to) return this.roles.has(`${to.organization} ${user}`);
    const me = this.users.get(user)!;
    return me.verified && me.email.toLowerCase() === to.email;
  }

  level(user: string | null, token: string | null, kind: string, id: string): number {
    const found = this.chain(kind, id);
    if (!found) return 0;
    const { chain, top } = found;
    const cut = chain.findIndex((node) => node.restricted);
    const reach = cut < 0 ? chain : chain.slice(0, cut + 1);
    const levels = [0];

    if (top.kind === "user" && top.id === user) levels.push(MANAGE);
    if (top.kind === "organization") {
      for (const role of this.roleLevels(top.id, user)) {
        if (role === "owner") levels.push(MANAGE);
        if (role === "admin") levels.push(DELETE);
        if (role === "member" && cut < 0) levels.push(READ);
      }
    }
    for (const node of reach) {
      for (const grant of this.grants.values()) {
        if (grant.kind === node.kind && grant.id === node.id && this.matches(grant.to, user)) levels.push(grant.level);
      }
      const link = token ? this.links.get(token) : undefined;
      if (link && !link.expired && link.kind === node.kind && link.id === node.id) levels.push(link.level);
    }
    return Math.max(...levels);
  }

  topLevel(user: string | null, kind: string, id: string): number {
    if (!user) return 0;
    if (kind === "user") return id === user ? MANAGE : 0;
    const levels = this.roleLevels(id, user).map((role) => ({ owner: MANAGE, admin: DELETE, member: READ })[role] ?? 0);
    return Math.max(0, ...levels);
  }

  place(user: string | null, token: string | null, kind: string, id: string, parentKind: string, parentId: string): Outcome {
    const existing = this.item(kind, id);
    if (existing && this.level(user, token, kind, id) < WRITE) return 404;
    let above = 0;
    if (parentKind === "user" || parentKind === "organization") {
      if (this.topLevel(user, parentKind, parentId) < CREATE) return 404;
    } else {
      if (this.level(user, token, parentKind, parentId) < CREATE) return 404;
      const parentChain = this.chain(parentKind, parentId)!.chain;
      if (parentChain.some((node) => node.kind === kind && node.id === id)) return 409;
      above = parentChain.length;
    }
    if (above + 1 + this.height(kind, id) > MAX_DEPTH) return 409;
    this.items.set(`${kind} ${id}`, { kind, id, parentKind, parentId, restricted: existing?.restricted ?? false });
    return "ok";
  }

  height(kind: string, id: string): number {
    const children = [...this.items.values()].filter((node) => node.parentKind === kind && node.parentId === id);
    return children.length === 0 ? 0 : 1 + Math.max(...children.map((child) => this.height(child.kind, child.id)));
  }

  remove(user: string | null, token: string | null, kind: string, id: string): Outcome {
    if (this.level(user, token, kind, id) < DELETE) return 404;
    if ([...this.items.values()].some((node) => node.parentKind === kind && node.parentId === id)) return 409;
    this.items.delete(`${kind} ${id}`);
    for (const [key, grant] of this.grants) if (grant.kind === kind && grant.id === id) this.grants.delete(key);
    for (const [token, link] of this.links) if (link.kind === kind && link.id === id) this.links.delete(token);
    return "ok";
  }

  restrict(user: string | null, token: string | null, kind: string, id: string, restricted: boolean): Outcome {
    if (this.level(user, token, kind, id) < MANAGE) return 404;
    this.item(kind, id)!.restricted = restricted;
    return "ok";
  }

  share(user: string | null, token: string | null, kind: string, id: string, to: Grantee, level: number): Outcome {
    if (this.level(user, token, kind, id) < MANAGE) return 404;
    if ("user" in to && !this.users.has(to.user)) return 404;
    if ("team" in to && !this.teams.has(to.team)) return 404;
    if ("organization" in to && !this.orgs.has(to.organization)) return 404;
    this.grants.set(`${kind} ${id} ${JSON.stringify(to)}`, { kind, id, to, level });
    return "ok";
  }

  revoke(user: string | null, token: string | null, kind: string, id: string, to: Grantee): Outcome {
    if (this.level(user, token, kind, id) < MANAGE) return 404;
    this.grants.delete(`${kind} ${id} ${JSON.stringify(to)}`);
    return "ok";
  }

  canLink(user: string | null, token: string | null, kind: string, id: string): Outcome {
    return this.level(user, token, kind, id) < MANAGE ? 404 : "ok";
  }

  deleteUser(user: string): void {
    this.users.delete(user);
    for (const key of [...this.roles.keys()]) if (key.endsWith(` ${user}`)) this.roles.delete(key);
    for (const key of [...this.teamMembers]) if (key.endsWith(` ${user}`)) this.teamMembers.delete(key);
    for (const [key, grant] of this.grants) if ("user" in grant.to && grant.to.user === user) this.grants.delete(key);
  }
}

// A small seeded generator, so a failing run can be replayed from its seed.
export function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!,
    chance: (p: number) => next() < p,
  };
}
