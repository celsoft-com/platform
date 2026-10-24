create table notes (
  id bigint generated always as identity primary key,
  body text not null check (length(body) between 1 and 10000),
  created_at timestamptz not null default now()
);
