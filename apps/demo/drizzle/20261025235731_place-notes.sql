-- Personal notes written before access was on become items under their authors.
insert into access_item (kind, id, parent_kind, parent_id)
select 'note', id::text, 'user', user_id::text from notes where organization_id is null
on conflict (kind, id) do nothing;
