-- =====================================================================
-- VK Gestion — une demande qui explique comment la faire
--
-- Jordan : « n'hésite pas à mettre des aide-mémoire si elle oublie
-- comment faire sur chaque action, ou redirection vers le lien d'aide ».
--
-- Le raisonnement est juste. Une demande qui dit quoi faire sans dire
-- comment oblige à aller chercher ailleurs, et c'est exactement le moment
-- où l'on repousse. On attache donc à chaque tâche le sujet du mode
-- d'emploi qui la concerne : un bouton, et le bon chapitre s'ouvre.
--
-- Le sujet est un simple texte — l'identifiant d'une section du guide. Pas
-- de table de référence : le guide est un fichier du site, la base n'a pas
-- à connaître son sommaire, et une contrainte ici casserait au premier
-- chapitre renommé. Si le sujet n'existe plus, le bouton ne s'affiche pas.
-- =====================================================================

alter table public.tasks
  add column if not exists help_topic text;

comment on column public.tasks.help_topic is
  'Identifiant d''une section de guide.html (« fournisseurs », « email »…). '
  'Affiche un bouton « Comment faire » sur la tâche. Sans contrainte : le '
  'guide vit dans le site, pas dans la base.';

-- Le paramètre s'ajoute à la fin : les appels existants continuent de
-- fonctionner sans être modifiés.
create or replace function public.task_create(
  p_title text, p_details text default null,
  p_due date default null, p_priority text default 'normale',
  p_assigned uuid default null, p_help text default null
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
                            created_by, created_name, assigned_to, assigned_name,
                            help_topic)
  values (btrim(p_title), nullif(btrim(coalesce(p_details, '')), ''), p_due,
          coalesce(nullif(p_priority, ''), 'normale'),
          auth.uid(), v_moi, p_assigned, v_lui,
          nullif(btrim(coalesce(p_help, '')), ''))
  returning id into v_id;

  return json_build_object('id', v_id);
end;
$$;

revoke all on function public.task_create(text, text, date, text, uuid, text) from public;
grant execute on function public.task_create(text, text, date, text, uuid, text) to authenticated;

-- L'ancienne signature à cinq paramètres est retirée : deux fonctions de
-- même nom rendraient l'appel ambigu côté PostgREST, qui refuserait alors
-- les deux. Le front appelle la nouvelle.
drop function if exists public.task_create(text, text, date, text, uuid);

/** Permettre de rattacher un sujet d'aide à une tâche déjà créée. */
create or replace function public.task_help(p_id uuid, p_help text)
returns json language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  if not public.is_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  update public.tasks
     set help_topic = nullif(btrim(coalesce(p_help, '')), ''), updated_at = now()
   where id = p_id;
  if not found then raise exception 'Tâche introuvable.'; end if;
  return json_build_object('ok', true);
end;
$$;

revoke all on function public.task_help(uuid, text) from public;
grant execute on function public.task_help(uuid, text) to authenticated;

-- task_list renvoie déjà toutes les colonnes de la table : help_topic
-- suit sans modification.
