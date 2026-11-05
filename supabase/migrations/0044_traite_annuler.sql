-- =====================================================================
-- 0044 — Annuler « Dossier traité » ; signaler un problème sur un dossier
--
-- LE PROBLÈME. « Attention : le client conteste la facture », « pièce
-- livrée cassée » : un signal qui doit sauter aux yeux de quiconque ouvre
-- le dossier ou parcourt la liste, jusqu'à ce que quelqu'un le dise
-- résolu. Une seule mention à la fois ; le fil garde l'histoire.
--
-- CLÔTURER LE DOSSIER. « Traité » dit que le travail du moment est fait ;
-- « clôturé » range le dossier : il quitte « En cours », passe dans
-- « Clôturés », et se rouvre d'un geste. Les fiches restent telles quelles.
--
-- « Dossier traité » efface le reste à faire, son échéance et l'urgence.
-- Un clic de trop, et le travail à faire disparaissait sans retour.
-- Désormais le travail noté garde ce qu'il a effacé (avant), et
-- l'annuler le remet tel quel. La ligne du fil reste, barrée : on voit
-- qu'elle a existé et qui l'a annulée.
--
-- Pour les dossiers marqués traités AVANT cette migration, rien n'a été
-- gardé : on relit le fil, qui avait noté le reste à faire, l'échéance et
-- l'urgence au moment où ils ont été écrits.
-- =====================================================================

alter table public.client_notes
  add column if not exists avant      jsonb,
  add column if not exists annule_le  timestamptz,
  add column if not exists annule_par text;

-- Le travail noté garde désormais ce qu'il efface
create or replace function public.client_travail(
  p_file uuid, p_kind text, p_date date default null, p_texte text default null,
  p_job uuid default null, p_fini boolean default false
) returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_label text;
  v_date  date := coalesce(p_date, current_date);
  v_texte text := nullif(btrim(coalesce(p_texte, '')), '');
  v_f     public.client_files%rowtype;
  v_efface boolean := p_fini or p_kind = 'traite';
  v_id    uuid;
begin
  if not public.is_client_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  v_label := case p_kind
    when 'mail'     then 'Mail envoyé'
    when 'appel'    then 'Client appelé'
    when 'devis'    then 'Devis envoyé'
    when 'commande' then 'Commande passée'
    when 'rdv'      then 'Rendez-vous fixé'
    when 'visite'   then 'Passage chez le client'
    when 'autre'    then 'Fait'
    when 'traite'   then 'Dossier traité'
    else null end;
  if v_label is null then
    raise exception 'Sorte de travail inconnue : %', p_kind;
  end if;
  if p_kind = 'autre' and v_texte is null then
    raise exception 'Écris ce qui a été fait.';
  end if;
  if v_date > current_date + 1 then
    raise exception 'Un travail fait ne peut pas être daté dans le futur.';
  end if;
  select * into v_f from public.client_files where id = p_file for update;
  if not found then
    raise exception 'Dossier introuvable.';
  end if;

  insert into public.client_notes (file_id, job_id, body, automatique, author, author_name, work_kind, work_date, avant)
  values (p_file, p_job,
          '✓ ' || v_label || ' le ' || to_char(v_date, 'DD/MM/YYYY') || coalesce(' — ' || v_texte, ''),
          false, auth.uid(), public._client_moi(), p_kind, v_date,
          case when v_efface then jsonb_build_object('todo', v_f.todo, 'todo_due', v_f.todo_due, 'todo_urgent', v_f.todo_urgent) end)
  returning id into v_id;

  if v_efface then
    update public.client_files set todo = null, todo_due = null, todo_urgent = false where id = p_file;
  else
    update public.client_files set updated_at = now() where id = p_file;
  end if;
  return json_build_object('ok', true, 'id', v_id);
end;
$$;

-- Annuler un travail noté. Sans p_note : le dernier « Dossier traité »
-- encore valable du dossier.
create or replace function public.client_travail_annuler(p_file uuid, p_note uuid default null)
returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_n     public.client_notes%rowtype;
  v_f     public.client_files%rowtype;
  v_todo  text;
  v_due   date;
  v_urg   boolean;
  v_txt   text;
begin
  if not public.is_client_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  select * into v_n from public.client_notes
   where file_id = p_file and work_kind is not null and annule_le is null
     and (case when p_note is null then work_kind = 'traite' else id = p_note end)
   order by created_at desc limit 1;
  if not found then
    raise exception 'Rien à annuler sur ce dossier.';
  end if;
  select * into v_f from public.client_files where id = p_file for update;

  if v_n.avant is not null then
    v_todo := v_n.avant->>'todo';
    v_due  := nullif(v_n.avant->>'todo_due', '')::date;
    v_urg  := coalesce((v_n.avant->>'todo_urgent')::boolean, false);
  elsif v_n.work_kind = 'traite' then
    -- Marqué avant 0044 : on relit le fil d'avant ce geste
    select case when body like 'Reste à faire : %' then substring(body from length('Reste à faire : ') + 1) end into v_txt
      from public.client_notes
     where file_id = p_file and automatique and created_at < v_n.created_at
       and (body like 'Reste à faire : %' or body = 'Reste à faire effacé')
     order by created_at desc limit 1;
    v_todo := v_txt;
    select case when body like 'À faire pour le %' then to_date(substring(body from length('À faire pour le ') + 1), 'DD/MM/YYYY') end into v_due
      from public.client_notes
     where file_id = p_file and automatique and created_at < v_n.created_at
       and (body like 'À faire pour le %' or body = 'Échéance retirée')
     order by created_at desc limit 1;
    select body = 'Marqué urgent' into v_urg
      from public.client_notes
     where file_id = p_file and automatique and created_at < v_n.created_at
       and body in ('Marqué urgent', 'Plus urgent')
     order by created_at desc limit 1;
    v_urg := coalesce(v_urg, false);
  end if;

  update public.client_notes
     set annule_le = now(), annule_par = public._client_moi()
   where id = v_n.id;

  -- Le reste à faire ne revient que s'il a été effacé par ce geste et
  -- qu'on n'en a pas écrit un autre depuis.
  if (v_n.avant is not null or v_n.work_kind = 'traite')
     and coalesce(btrim(v_f.todo), '') = '' then
    update public.client_files
       set todo = v_todo, todo_due = v_due, todo_urgent = coalesce(v_urg, false)
     where id = p_file;
  else
    update public.client_files set updated_at = now() where id = p_file;
  end if;

  insert into public.client_notes (file_id, body, automatique, author, author_name)
  values (p_file, 'Annulé : ' || v_n.body, false, auth.uid(), public._client_moi());

  return json_build_object('ok', true, 'todo', v_todo);
end;
$$;

-- La liste : le dernier travail encore valable
create or replace function public.client_file_list()
returns json language sql stable security definer
set search_path = public, pg_temp as $$
  select coalesce(json_agg(d order by d.updated_at desc), '[]'::json)
    from (
      select f.*,
             coalesce((select json_agg(j order by j.created_at)
                         from public.client_jobs j where j.file_id = f.id), '[]'::json) as jobs,
             (select json_build_object('body', n.body, 'author_name', n.author_name,
                                       'created_at', n.created_at, 'automatique', n.automatique)
                from public.client_notes n where n.file_id = f.id
               order by n.created_at desc limit 1) as last_note,
             (select json_build_object('id', n.id, 'kind', n.work_kind, 'date', n.work_date,
                                       'body', n.body, 'author_name', n.author_name)
                from public.client_notes n
               where n.file_id = f.id and n.work_kind is not null and n.annule_le is null
               order by n.work_date desc, n.created_at desc limit 1) as last_work
        from public.client_files f
       where public.is_client_member()
    ) d;
$$;

-- ---------------------------------------------------------------------
-- Le problème signalé
-- ---------------------------------------------------------------------
alter table public.client_files
  add column if not exists probleme      text,
  add column if not exists probleme_le   timestamptz,
  add column if not exists probleme_par  text;

-- p_texte rempli : signaler (ou corriger) ; vide : résolu.
create or replace function public.client_probleme(p_file uuid, p_texte text default null)
returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_texte text := nullif(btrim(coalesce(p_texte, '')), '');
  v_f     public.client_files%rowtype;
begin
  if not public.is_client_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  select * into v_f from public.client_files where id = p_file for update;
  if not found then
    raise exception 'Dossier introuvable.';
  end if;
  if v_texte is null and v_f.probleme is null then
    raise exception 'Aucun problème signalé sur ce dossier.';
  end if;

  update public.client_files
     set probleme = v_texte,
         probleme_le = case when v_texte is null then null else now() end,
         probleme_par = case when v_texte is null then null else public._client_moi() end
   where id = p_file;

  insert into public.client_notes (file_id, body, automatique, author, author_name)
  values (p_file,
          case when v_texte is null then 'Problème résolu : ' || v_f.probleme
               else '⚠ Problème : ' || v_texte end,
          false, auth.uid(), public._client_moi());
  return json_build_object('ok', true, 'probleme', v_texte);
end;
$$;

-- ---------------------------------------------------------------------
-- Clôturer, rouvrir le dossier
-- ---------------------------------------------------------------------
alter table public.client_files
  add column if not exists closed_at   timestamptz,
  add column if not exists closed_name text;

create or replace function public.client_dossier_cloturer(p_file uuid, p_rouvrir boolean default false)
returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_f public.client_files%rowtype;
begin
  if not public.is_client_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  select * into v_f from public.client_files where id = p_file for update;
  if not found then raise exception 'Dossier introuvable.'; end if;
  if p_rouvrir then
    if v_f.closed_at is null then raise exception 'Ce dossier n''est pas clôturé.'; end if;
    update public.client_files set closed_at = null, closed_name = null where id = p_file;
  else
    if v_f.closed_at is not null then raise exception 'Ce dossier est déjà clôturé.'; end if;
    -- Un dossier rangé n'attend plus rien de personne
    update public.client_files
       set closed_at = now(), closed_name = public._client_moi(), todo_urgent = false
     where id = p_file;
  end if;
  insert into public.client_notes (file_id, body, automatique, author, author_name)
  values (p_file, case when p_rouvrir then 'Dossier rouvert' else 'Dossier clôturé' end,
          false, auth.uid(), public._client_moi());
  return json_build_object('ok', true, 'clos', not p_rouvrir);
end;
$$;

revoke all on function public.client_dossier_cloturer(uuid, boolean) from public;
grant execute on function public.client_dossier_cloturer(uuid, boolean) to authenticated;

revoke all on function public.client_probleme(uuid, text) from public;
grant execute on function public.client_probleme(uuid, text) to authenticated;

revoke all on function public.client_travail_annuler(uuid, uuid) from public;
grant execute on function public.client_travail_annuler(uuid, uuid) to authenticated;
