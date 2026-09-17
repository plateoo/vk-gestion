-- =====================================================================
-- VK Gestion — d'où vient la demande
--
-- Jordan : « je veux qu'elle puisse différencier les demandes générales et
-- les demandes que je formule personnellement, qui sont forcément plus
-- urgentes. »
--
-- Le nom de l'auteur ne suffisait pas, et ne pouvait pas suffire : la
-- liste de mise en route a été créée depuis le compte du gérant, donc
-- TOUT portait « de Jordan ». Une mention qui s'applique à tout n'informe
-- de rien.
--
-- Deux origines, pas plus :
--   gerant  — ce que Jordan demande en son nom. Ce qui lui passe par la
--             tête dans la voiture, ce qu'il faut faire aujourd'hui.
--   general — le travail courant : contrôler, valider, encoder. Il est
--             là tous les jours, il ne vient de personne en particulier.
--
-- Un troisième cas ne servirait à rien : ce qui compte pour Marie, c'est
-- « le patron me demande ça » ou « c'est mon travail de fond ». Il n'y a
-- pas d'entre-deux utile.
-- =====================================================================

alter table public.tasks
  add column if not exists origine text not null default 'general';

alter table public.tasks
  drop constraint if exists tasks_origine_check;
alter table public.tasks
  add constraint tasks_origine_check check (origine in ('gerant', 'general'));

comment on column public.tasks.origine is
  'gerant = demande personnelle du gérant, passe en tête de liste. '
  'general = travail courant. Le nom de l''auteur ne suffit pas : la liste '
  'de mise en route a été créée depuis le compte du gérant.';

create index if not exists tasks_origine_idx on public.tasks (origine)
  where status = 'a_faire';

-- ---------------------------------------------------------------------
-- Créer une tâche
--
-- L'origine se devine dans le cas normal : ce que le gérant tape dans
-- l'application EST une demande personnelle — c'est même le seul usage
-- qu'il en a. Ce que la secrétaire note est son travail. Le paramètre
-- reste disponible pour les cas où l'on sait mieux, comme la liste de
-- mise en route.
--
-- Deviner plutôt que demander : un menu de plus à chaque ajout, et la
-- liste cesse d'être alimentée depuis un téléphone.
-- ---------------------------------------------------------------------
create or replace function public.task_create(
  p_title text, p_details text default null,
  p_due date default null, p_priority text default 'normale',
  p_assigned uuid default null, p_help text default null,
  p_origine text default null
) returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_moi text;
  v_lui text;
  v_origine text;
begin
  if not public.is_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_title), '') = '' then
    raise exception 'Une tâche a besoin d''un intitulé.';
  end if;

  select full_name into v_moi from public.profiles where id = auth.uid();
  select full_name into v_lui from public.profiles where id = p_assigned;

  v_origine := coalesce(nullif(btrim(coalesce(p_origine, '')), ''),
                        case when public.is_manager() then 'gerant' else 'general' end);
  if v_origine not in ('gerant', 'general') then
    raise exception 'Origine inconnue : %', v_origine;
  end if;

  insert into public.tasks (title, details, due_date, priority,
                            created_by, created_name, assigned_to, assigned_name,
                            help_topic, origine)
  values (btrim(p_title), nullif(btrim(coalesce(p_details, '')), ''), p_due,
          coalesce(nullif(p_priority, ''), 'normale'),
          auth.uid(), v_moi, p_assigned, v_lui,
          nullif(btrim(coalesce(p_help, '')), ''), v_origine)
  returning id into v_id;

  return json_build_object('id', v_id, 'origine', v_origine);
end;
$$;

revoke all on function public.task_create(text, text, date, text, uuid, text, text) from public;
grant execute on function public.task_create(text, text, date, text, uuid, text, text) to authenticated;

-- Deux fonctions de même nom rendraient l'appel ambigu pour PostgREST,
-- qui refuserait alors les deux.
drop function if exists public.task_create(text, text, date, text, uuid, text);

/** Corriger l'origine d'une demande déjà créée. */
create or replace function public.task_origine(p_id uuid, p_origine text)
returns json language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  if not public.is_manager() then
    raise exception 'Seul le gérant peut changer l''origine d''une demande.'
      using errcode = '42501';
  end if;
  if p_origine not in ('gerant', 'general') then
    raise exception 'Origine inconnue : %', p_origine;
  end if;
  update public.tasks set origine = p_origine, updated_at = now() where id = p_id;
  if not found then raise exception 'Tâche introuvable.'; end if;
  return json_build_object('ok', true);
end;
$$;

revoke all on function public.task_origine(uuid, text) from public;
grant execute on function public.task_origine(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- L'ordre de la liste
--
-- Les demandes du gérant passent devant. C'est exactement ce que Jordan
-- décrit — « forcément plus urgentes » — et c'est un choix assumé : une
-- tâche courante marquée urgente passera derrière une demande du gérant
-- notée « quand tu peux ». Si cela se retourne contre nous, c'est
-- l'ordre qu'il faudra changer, pas la mention.
-- ---------------------------------------------------------------------
create or replace function public.task_list(p_closes boolean default false)
returns json language sql stable security definer
set search_path = public, pg_temp as $$
  select coalesce(json_agg(t order by t.rang_origine, t.rang, t.due_date nulls last, t.created_at desc), '[]'::json)
    from (
      select k.*,
             case k.origine when 'gerant' then 0 else 1 end as rang_origine,
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

/** La pastille distingue ce que le gérant a demandé en propre. */
create or replace function public.task_count()
returns json language sql stable security definer
set search_path = public, pg_temp as $$
  select json_build_object(
    'a_faire',   count(*) filter (where status = 'a_faire'),
    'en_retard', count(*) filter (where status = 'a_faire' and due_date is not null and due_date < current_date),
    'pour_moi',  count(*) filter (where status = 'a_faire' and assigned_to = auth.uid()),
    'du_gerant', count(*) filter (where status = 'a_faire' and origine = 'gerant')
  ) from public.tasks where public.is_member();
$$;

revoke all on function public.task_list(boolean) from public;
revoke all on function public.task_count() from public;
grant execute on function public.task_list(boolean) to authenticated;
grant execute on function public.task_count() to authenticated;
