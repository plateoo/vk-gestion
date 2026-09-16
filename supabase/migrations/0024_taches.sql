-- =====================================================================
-- VK Gestion — la liste des choses à faire
--
-- Jordan pense à quelque chose en voiture, il l'ajoute depuis son
-- téléphone. Marie la voit, la fait, la refuse ou la reporte, et peut
-- répondre. C'est un échange, pas un carnet d'ordres : d'où les
-- commentaires, et d'où le fait que Marie puisse créer une tâche elle
-- aussi — elle a des choses à demander en retour.
--
-- Trois états seulement. « Reportée » n'en est pas un : une tâche
-- reportée reste à faire, avec une date plus lointaine. Un état de plus
-- aurait donné une liste où l'on ne sait plus ce qui attend vraiment.
-- =====================================================================

create table if not exists public.tasks (
  id            uuid primary key default gen_random_uuid(),
  title         text not null check (btrim(title) <> ''),
  details       text,
  status        text not null default 'a_faire'
                check (status in ('a_faire', 'faite', 'annulee')),
  -- Faible, normale, haute. Une seule tâche urgente se voit ; dix ne se
  -- voient plus.
  priority      text not null default 'normale'
                check (priority in ('basse', 'normale', 'haute')),
  due_date      date,
  -- Combien de fois elle a été repoussée. Un chiffre qui monte dit
  -- quelque chose qu'aucun statut ne dirait.
  postponed     int not null default 0,
  created_by    uuid references auth.users,
  created_name  text,
  assigned_to   uuid references auth.users,
  assigned_name text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  closed_at     timestamptz
);

create index if not exists tasks_ouvertes_idx on public.tasks (due_date nulls last, created_at desc)
  where status = 'a_faire';
create index if not exists tasks_assignee_idx on public.tasks (assigned_to) where status = 'a_faire';

create table if not exists public.task_comments (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks(id) on delete cascade,
  body        text not null check (btrim(body) <> ''),
  author      uuid references auth.users,
  author_name text,
  -- Un mot écrit par l'application elle-même — « reportée au 24/09 » —
  -- se distingue de ce qu'une personne a tapé.
  automatique boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists task_comments_idx on public.task_comments (task_id, created_at);

-- ---------------------------------------------------------------------
-- Accès : les deux voient tout, les deux écrivent.
--
-- Une liste partagée entre deux personnes n'a pas à être cloisonnée : si
-- Marie ne voyait que ce qui lui est assigné, elle ne saurait pas ce que
-- Jordan s'est noté à lui-même, et l'intérêt d'une liste commune
-- disparaîtrait.
-- ---------------------------------------------------------------------
alter table public.tasks enable row level security;
alter table public.task_comments enable row level security;

drop policy if exists tasks_read on public.tasks;
create policy tasks_read on public.tasks for select using (public.is_member());
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert with check (public.is_member());
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update using (public.is_member()) with check (public.is_member());
-- Supprimer efface aussi l'échange qui s'y rattache : réservé au gérant.
drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks for delete using (public.is_manager());

drop policy if exists comments_read on public.task_comments;
create policy comments_read on public.task_comments for select using (public.is_member());
drop policy if exists comments_insert on public.task_comments;
create policy comments_insert on public.task_comments for insert with check (public.is_member());

-- ---------------------------------------------------------------------
-- Créer une tâche. Le nom de l'auteur est figé à la création : si un
-- compte est renommé plus tard, l'historique ne doit pas se réécrire.
-- ---------------------------------------------------------------------
create or replace function public.task_create(
  p_title text, p_details text default null,
  p_due date default null, p_priority text default 'normale',
  p_assigned uuid default null
) returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_moi text;
  v_lui text;
begin
  if not public.is_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_title), '') = '' then
    raise exception 'Une tâche a besoin d''un intitulé.';
  end if;

  select full_name into v_moi from public.profiles where id = auth.uid();
  select full_name into v_lui from public.profiles where id = p_assigned;

  insert into public.tasks (title, details, due_date, priority,
                            created_by, created_name, assigned_to, assigned_name)
  values (btrim(p_title), nullif(btrim(coalesce(p_details, '')), ''), p_due,
          coalesce(nullif(p_priority, ''), 'normale'),
          auth.uid(), v_moi, p_assigned, v_lui)
  returning id into v_id;

  return json_build_object('id', v_id);
end;
$$;

-- ---------------------------------------------------------------------
-- Changer l'état, ou reporter.
--
-- Chaque geste laisse une trace écrite dans l'échange : sans cela, une
-- tâche annulée ne dirait pas par qui ni quand, et il faudrait redemander.
-- ---------------------------------------------------------------------
create or replace function public.task_set_status(
  p_id uuid, p_status text, p_note text default null
) returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_moi text;
  v_avant text;
begin
  if not public.is_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  if p_status not in ('a_faire', 'faite', 'annulee') then
    raise exception 'État inconnu : %', p_status;
  end if;

  select status into v_avant from public.tasks where id = p_id;
  if v_avant is null then raise exception 'Tâche introuvable.'; end if;

  select full_name into v_moi from public.profiles where id = auth.uid();

  update public.tasks
     set status = p_status,
         closed_at = case when p_status = 'a_faire' then null else now() end,
         updated_at = now()
   where id = p_id;

  insert into public.task_comments (task_id, body, author, author_name, automatique)
  values (p_id,
          case p_status
            when 'faite'   then 'Marquée faite'
            when 'annulee' then 'Annulée'
            else 'Remise à faire' end
          || case when coalesce(btrim(coalesce(p_note, '')), '') <> ''
                  then ' — ' || btrim(p_note) else '' end,
          auth.uid(), v_moi, coalesce(btrim(coalesce(p_note, '')), '') = '');

  return json_build_object('id', p_id, 'status', p_status, 'avant', v_avant);
end;
$$;

/** Reporter : la tâche reste à faire, sa date bouge, et cela se voit. */
create or replace function public.task_postpone(p_id uuid, p_due date, p_note text default null)
returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_moi text;
  v_n int;
begin
  if not public.is_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  if p_due is null then raise exception 'Une date est nécessaire pour reporter.'; end if;

  select full_name into v_moi from public.profiles where id = auth.uid();

  update public.tasks
     set due_date = p_due, postponed = postponed + 1,
         status = 'a_faire', closed_at = null, updated_at = now()
   where id = p_id
  returning postponed into v_n;
  if v_n is null then raise exception 'Tâche introuvable.'; end if;

  insert into public.task_comments (task_id, body, author, author_name, automatique)
  values (p_id, 'Reportée au ' || to_char(p_due, 'DD/MM/YYYY')
                || case when coalesce(btrim(coalesce(p_note, '')), '') <> ''
                        then ' — ' || btrim(p_note) else '' end,
          auth.uid(), v_moi, coalesce(btrim(coalesce(p_note, '')), '') = '');

  return json_build_object('id', p_id, 'due', p_due, 'reports', v_n);
end;
$$;

/** Ajouter un mot à l'échange. */
create or replace function public.task_comment(p_id uuid, p_body text)
returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_moi text;
begin
  if not public.is_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  if coalesce(btrim(coalesce(p_body, '')), '') = '' then
    raise exception 'Le commentaire est vide.';
  end if;
  if not exists (select 1 from public.tasks where id = p_id) then
    raise exception 'Tâche introuvable.';
  end if;
  select full_name into v_moi from public.profiles where id = auth.uid();
  insert into public.task_comments (task_id, body, author, author_name)
  values (p_id, btrim(p_body), auth.uid(), v_moi);
  update public.tasks set updated_at = now() where id = p_id;
  return json_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------
-- La liste, avec son échange. Une seule requête : sur un téléphone en
-- 4G, trois allers-retours se sentent.
-- ---------------------------------------------------------------------
create or replace function public.task_list(p_closes boolean default false)
returns json language sql stable security definer
set search_path = public, pg_temp as $$
  select coalesce(json_agg(t order by t.rang, t.due_date nulls last, t.created_at desc), '[]'::json)
    from (
      select k.*,
             case k.priority when 'haute' then 0 when 'normale' then 1 else 2 end as rang,
             coalesce((
               select json_agg(c order by c.created_at)
                 from (select body, author_name, automatique, created_at
                         from public.task_comments where task_id = k.id
                        order by created_at) c), '[]'::json) as comments
        from public.tasks k
       where public.is_member()
         and (p_closes or k.status = 'a_faire')
    ) t;
$$;

/** Ce que la pastille affiche : ce qui reste à faire. */
create or replace function public.task_count()
returns json language sql stable security definer
set search_path = public, pg_temp as $$
  select json_build_object(
    'a_faire', count(*) filter (where status = 'a_faire'),
    'en_retard', count(*) filter (where status = 'a_faire' and due_date is not null and due_date < current_date),
    'pour_moi', count(*) filter (where status = 'a_faire' and assigned_to = auth.uid())
  ) from public.tasks where public.is_member();
$$;

revoke all on function public.task_create(text, text, date, text, uuid) from public;
revoke all on function public.task_set_status(uuid, text, text) from public;
revoke all on function public.task_postpone(uuid, date, text) from public;
revoke all on function public.task_comment(uuid, text) from public;
revoke all on function public.task_list(boolean) from public;
revoke all on function public.task_count() from public;

grant execute on function public.task_create(text, text, date, text, uuid) to authenticated;
grant execute on function public.task_set_status(uuid, text, text) to authenticated;
grant execute on function public.task_postpone(uuid, date, text) to authenticated;
grant execute on function public.task_comment(uuid, text) to authenticated;
grant execute on function public.task_list(boolean) to authenticated;
grant execute on function public.task_count() to authenticated;
