// The access rules of docs/access-rules.md written the plainest way, in memory, to check the
// Postgres version against on random worlds. Nothing here is clever; that is the point.

export interface RefPoint {
  id: string;
  parent: string | null;
  inherits: boolean;
  organization: string | null;
}

export type RefGrant = { point: string; level: number } & (
  | { user: string }
  | { team: string }
  | { organization: string }
  | { email: string }
  | { everyone: true }
);

export const MAX_DEPTH = 64;

export class Reference {
  users = new Map<string, { email: string; verified: boolean }>();
  members = new Set<string>(); // `${org} ${user}`
  teams = new Map<string, { organization: string; admins: boolean }>();
  teamMembers = new Set<string>(); // `${team} ${user}`
  points = new Map<string, RefPoint>();
  grants: RefGrant[] = [];
  links = new Map<string, { point: string; level: number; expired: boolean }>(); // by token

  level(user: string | null, token: string | null, pointId: string): number {
    const point = this.points.get(pointId);
    if (!point) return 0;
    const chain: { point: RefPoint; depth: number }[] = [{ point, depth: 0 }];
    let current = point;
    while (current.inherits && current.parent && chain.length < MAX_DEPTH) {
      current = this.points.get(current.parent)!;
      chain.push({ point: current, depth: chain.length });
    }

    const person = user ? this.users.get(user) : undefined;
    const email = person?.verified ? person.email.toLowerCase() : null;
    const inOrg = (org: string) => user !== null && this.members.has(`${org} ${user}`);
    const inTeam = (team: string) => user !== null && this.teamMembers.has(`${team} ${user}`) && inOrg(this.teams.get(team)!.organization);

    const nearest = new Map<string, { depth: number; level: number }>();
    for (const { point: at, depth } of chain) {
      for (const g of this.grants.filter((x) => x.point === at.id)) {
        let principal: string | null = null;
        if ("everyone" in g) principal = "everyone";
        else if ("user" in g && user !== null && g.user === user) principal = "person";
        else if ("email" in g && email !== null && g.email === email) principal = "person";
        else if ("organization" in g && inOrg(g.organization) && (at.organization === null || at.organization === g.organization)) principal = `organization ${g.organization}`;
        else if ("team" in g && inTeam(g.team) && (at.organization === null || at.organization === this.teams.get(g.team)!.organization)) principal = `team ${g.team}`;
        if (!principal) continue;
        const seen = nearest.get(principal);
        if (!seen || depth < seen.depth || (depth === seen.depth && g.level > seen.level)) nearest.set(principal, { depth, level: g.level });
      }
    }
    let level = Math.max(0, ...[...nearest.values()].map((n) => n.level));

    if (point.organization) {
      for (const [team, t] of this.teams) if (t.admins && t.organization === point.organization && inTeam(team)) level = Math.max(level, 5);
    }
    if (token) {
      const link = this.links.get(token);
      if (link && link.point === pointId && !link.expired) level = Math.max(level, link.level);
    }
    return level;
  }
}

// A small seeded random source, so a failing world can be run again by its seed.
export function random(seed: number) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    chance: (p: number) => next() < p,
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(next() * items.length)]!;
    },
  };
}
