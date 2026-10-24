-- "user" is created by the platform's auth tables, which run before these migrations.
alter table notes add column user_id text references "user"(id) on delete cascade;
create index notes_user_created on notes (user_id, created_at desc);
