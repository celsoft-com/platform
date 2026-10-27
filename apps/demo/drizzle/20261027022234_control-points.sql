-- Moves the demo from Better Auth's organization roles and access items to the platform's own
-- organizations and control points, before the old columns and the item table are dropped.

-- Each organization gets its Admins team, holding everyone who was an owner or admin.
insert into team (name, organization_id, admins)
select 'Admins', o.id, true from organization o
where not exists (select 1 from team t where t.organization_id = o.id and t.admins);
--> statement-breakpoint
insert into team_member (team_id, user_id)
select t.id, m.user_id from member m join team t on t.organization_id = m.organization_id and t.admins
where exists (select 1 from unnest(string_to_array(m.role, ',')) as r(name) where btrim(r.name) in ('owner', 'admin'))
  and not exists (select 1 from team_member x where x.team_id = t.id and x.user_id = m.user_id);
--> statement-breakpoint

-- Each organization's point: its members may read it and, in the demo, add notes under it.
insert into access_point (id, organization_id, for_organization)
select 'organization:' || o.id, o.id, o.id from organization o on conflict (id) do nothing;
--> statement-breakpoint
insert into access_grant (point_id, organization_id, level)
select 'organization:' || o.id, o.id, 2 from organization o;
--> statement-breakpoint

-- Each team's point, under its organization's, granting the team write.
insert into access_point (id, parent_id, organization_id, for_team)
select 'team:' || t.id, 'organization:' || t.organization_id, t.organization_id, t.id from team t on conflict (id) do nothing;
--> statement-breakpoint
insert into access_grant (point_id, team_id, level)
select 'team:' || t.id, t.id, 3 from team t;
--> statement-breakpoint

-- Every note is a point its author manages; an organization's note inherits from the organization.
insert into access_point (id, parent_id, organization_id, inherits, created_by)
select n.id::text, case when n.organization_id is null then null else 'organization:' || n.organization_id end, n.organization_id, n.organization_id is not null, n.user_id
from notes n on conflict (id) do nothing;
--> statement-breakpoint

-- Grants and links on notes move to their points; anything else held for an item goes.
update access_grant set point_id = item_id where item_kind = 'note' and point_id is null and exists (select 1 from access_point p where p.id = access_grant.item_id);
--> statement-breakpoint
delete from access_grant where point_id is null;
--> statement-breakpoint
insert into access_grant (point_id, user_id, level, granted_by)
select n.id::text, n.user_id, 5, n.user_id from notes n
where not exists (select 1 from access_grant g where g.point_id = n.id::text and g.user_id = n.user_id);
--> statement-breakpoint
update access_link set point_id = item_id where item_kind = 'note' and point_id is null and exists (select 1 from access_point p where p.id = access_link.item_id);
--> statement-breakpoint
delete from access_link where point_id is null;
--> statement-breakpoint

-- What the new constraints need: one row per member and team member, and one lowercase,
-- pending invitation per address, naming a team that still exists.
delete from member a using member b where a.organization_id = b.organization_id and a.user_id = b.user_id and a.id > b.id;
--> statement-breakpoint
delete from team_member a using team_member b where a.team_id = b.team_id and a.user_id = b.user_id and a.id > b.id;
--> statement-breakpoint
delete from invitation where status <> 'pending' or expires_at < now();
--> statement-breakpoint
update invitation set email = lower(email);
--> statement-breakpoint
delete from invitation a using invitation b where a.organization_id = b.organization_id and a.email = b.email and a.id < b.id;
--> statement-breakpoint
update invitation set team_id = null where team_id is not null and not exists (select 1 from team t where t.id = invitation.team_id);
