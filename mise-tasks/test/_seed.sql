-- Large data for a demo preview's load test: 1,000 people with 50 notes each, every note shared
-- with two others, and one note at the bottom of a 60-point chain that everyone can read through
-- its top, each point with 20 grants. Run once per preview; a second run changes nothing.
do $$
declare
  deep constant uuid := '00000000-0000-4000-8000-00000000dee9';
  author uuid;
  parent text;
begin
  if exists (select 1 from "user" where email = 'seed-0@seed.invalid') then
    return;
  end if;

  insert into "user" (name, email, email_verified)
  select 'Seed ' || n, 'seed-' || n || '@seed.invalid', true from generate_series(0, 999) n;

  create temp table seed_people on commit drop as
  select id, row_number() over (order by email) - 1 as n from "user" where email like 'seed-%@seed.invalid';

  create temp table seed_notes on commit drop as
  select gen_random_uuid() as id, p.id as user_id, p.n, k from seed_people p, generate_series(1, 50) k;

  insert into notes (id, user_id, body) select id, user_id, 'seed note ' || k from seed_notes;
  insert into access_point (id, created_by) select id::text, user_id from seed_notes;
  insert into access_grant (point_id, user_id, level, granted_by) select id::text, user_id, 5, user_id from seed_notes;
  insert into access_grant (point_id, user_id, level, granted_by)
  select s.id::text, o.id, 1, s.user_id from seed_notes s join seed_people o on o.n in ((s.n + 1) % 1000, (s.n + 7) % 1000);

  select id into author from seed_people where n = 0;
  parent := null;
  for i in 0..59 loop
    insert into access_point (id, parent_id, inherits, created_by) values ('seed-deep-' || i, parent, parent is not null, author);
    insert into access_grant (point_id, user_id, level, granted_by)
    select 'seed-deep-' || i, id, 1, author from seed_people where n between i * 10 and i * 10 + 19;
    parent := 'seed-deep-' || i;
  end loop;
  insert into access_grant (point_id, everyone, level, granted_by) values ('seed-deep-0', true, 1, author);
  insert into notes (id, user_id, body) values (deep, author, 'the deepest note');
  insert into access_point (id, parent_id, inherits, created_by) values (deep::text, parent, true, author);

  analyze;
end $$;
