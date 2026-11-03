-- =====================================================================
-- VK Gestion — les dossiers clients : poses et service après-vente
--
-- Jusqu'ici l'application ne connaissait que les fournisseurs. Les
-- clients du magasin vivaient ailleurs — un carnet, l'agenda, la mémoire
-- de Jordan. Un SAV commandé dont personne ne suit la réception est un
-- client qui rappelle trois semaines plus tard.
--
-- Trois niveaux, et pas un de plus :
--
--   client_files  le DOSSIER : qui est le client, comment le joindre, ce
--                 qu'il reste à faire chez lui.
--   client_jobs   les FICHES : une pose, ou un SAV. Un dossier en a
--                 souvent plusieurs : la pose, puis un SAV, puis une
--                 seconde intervention sur ce SAV.
--   client_notes  le FIL : ce qu'on a écrit, et ce qui s'est passé.
--
-- Une pose se termine de deux façons : clôturée, ou terminée AVEC un SAV.
-- Un SAV se termine de deux façons : clôturé, ou relancé en nouvelle
-- intervention. Dans les deux cas « avec suite », la suite est une
-- nouvelle fiche SAV reliée à la précédente (parent_id) : l'historique
-- d'un problème se lit en remontant la chaîne, et chaque intervention
-- garde ses propres dates.
--
-- Chaque changement d'état ou de date s'écrit dans le fil par
-- déclencheur, côté base : on ne demande jamais « c'est commandé ? » à
-- quelqu'un qui peut le lire.
--
-- Accès : comme la liste à faire, les deux voient tout et écrivent tout.
-- Supprimer un dossier ou une fiche efface son histoire : gérant seul.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABLES
-- ---------------------------------------------------------------------
create table if not exists public.client_files (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (btrim(name) <> ''),
  phone        text,
  email        text,
  address      text,
  -- Ce qu'il reste à faire chez ce client, en clair. Un champ libre, pas
  -- une liste : c'est ce que Jordan écrirait sur un post-it.
  todo         text,
  -- Comment le client est arrivé. Sert à retrouver « celui qui a
  -- téléphoné mardi », pas à faire des statistiques.
  source       text check (source in ('telephone', 'magasin', 'mail', 'autre')),
  created_by   uuid references auth.users,
  created_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.client_jobs (
  id                uuid primary key default gen_random_uuid(),
  file_id           uuid not null references public.client_files(id) on delete cascade,
  kind              text not null check (kind in ('pose', 'sav')),
  status            text not null,
  -- L'objet de la fiche : « cuisine complète », « porte de lave-vaisselle
  -- abîmée ». Facultatif : une pose n'a souvent rien à dire de plus.
  title             text,
  -- Remarques libres sur la fiche, modifiables à tout moment. Le fil,
  -- lui, garde l'histoire et ne se réécrit pas.
  remarks           text,
  delivery_date     date,
  pose_date         date,
  intervention_date date,
  -- Référence de la commande de pièces chez le fournisseur (SAV)
  order_ref         text,
  -- Par où ce SAV a été signalé
  source            text check (source in ('telephone', 'magasin', 'mail', 'autre')),
  -- La fiche dont celle-ci est la suite
  parent_id         uuid references public.client_jobs(id) on delete set null,
  created_by        uuid references auth.users,
  created_name      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  closed_at         timestamptz,
  constraint client_jobs_status_ck check (
    (kind = 'pose' and status in ('a_planifier', 'planifiee', 'terminee', 'sav'))
    or
    (kind = 'sav' and status in ('a_traiter', 'commande', 'recu', 'planifie',
                                 'cloture', 'nouvelle_intervention'))
  )
);

create index if not exists client_jobs_file_idx on public.client_jobs (file_id, created_at);
create index if not exists client_jobs_ouvertes_idx on public.client_jobs (kind, status)
  where closed_at is null;

create table if not exists public.client_notes (
  id          uuid primary key default gen_random_uuid(),
  file_id     uuid not null references public.client_files(id) on delete cascade,
  job_id      uuid references public.client_jobs(id) on delete set null,
  body        text not null check (btrim(body) <> ''),
  -- Écrit par la base (changement d'état, de date), pas par une personne
  automatique boolean not null default false,
  author      uuid references auth.users,
  author_name text,
  -- L'heure exacte, pas celle de la transaction : un geste qui écrit
  -- deux lignes (la pose close, le SAV ouvert) doit les garder dans l'ordre.
  created_at  timestamptz not null default clock_timestamp()
);

create index if not exists client_notes_file_idx on public.client_notes (file_id, created_at);

-- ---------------------------------------------------------------------
-- 2. ACCÈS
-- ---------------------------------------------------------------------
alter table public.client_files enable row level security;
alter table public.client_jobs  enable row level security;
alter table public.client_notes enable row level security;

drop policy if exists client_files_read on public.client_files;
create policy client_files_read on public.client_files for select using (public.is_member());
drop policy if exists client_files_insert on public.client_files;
create policy client_files_insert on public.client_files for insert with check (public.is_member());
drop policy if exists client_files_update on public.client_files;
create policy client_files_update on public.client_files for update using (public.is_member()) with check (public.is_member());
drop policy if exists client_files_delete on public.client_files;
create policy client_files_delete on public.client_files for delete using (public.is_manager());

drop policy if exists client_jobs_read on public.client_jobs;
create policy client_jobs_read on public.client_jobs for select using (public.is_member());
drop policy if exists client_jobs_insert on public.client_jobs;
create policy client_jobs_insert on public.client_jobs for insert with check (public.is_member());
drop policy if exists client_jobs_update on public.client_jobs;
create policy client_jobs_update on public.client_jobs for update using (public.is_member()) with check (public.is_member());
drop policy if exists client_jobs_delete on public.client_jobs;
create policy client_jobs_delete on public.client_jobs for delete using (public.is_manager());

-- Le fil se lit par tous. Il ne s'écrit que par client_note_add() et par
-- les déclencheurs : l'auteur est celui de la session, pas ce que le
-- navigateur prétend. Rien ne se corrige après coup.
drop policy if exists client_notes_read on public.client_notes;
create policy client_notes_read on public.client_notes for select using (public.is_member());
drop policy if exists client_notes_delete on public.client_notes;
create policy client_notes_delete on public.client_notes for delete using (public.is_manager());

-- ---------------------------------------------------------------------
-- 3. LIBELLÉS — une seule source, pour le fil
-- ---------------------------------------------------------------------
create or replace function public.client_status_label(p_kind text, p_status text)
returns text language sql immutable as $$
  select case p_kind || ':' || p_status
    when 'pose:a_planifier'          then 'À planifier'
    when 'pose:planifiee'            then 'Planifiée'
    when 'pose:terminee'             then 'Terminée'
    when 'pose:sav'                  then 'Terminée avec SAV'
    when 'sav:a_traiter'             then 'À traiter'
    when 'sav:commande'              then 'Commandé'
    when 'sav:recu'                  then 'Reçu'
    when 'sav:planifie'              then 'Planifié'
    when 'sav:cloture'               then 'Clôturé'
    when 'sav:nouvelle_intervention' then 'Nouvelle intervention'
    else p_status end;
$$;

create or replace function public.client_job_terminal(p_kind text, p_status text)
returns boolean language sql immutable as $$
  select (p_kind = 'pose' and p_status in ('terminee', 'sav'))
      or (p_kind = 'sav'  and p_status in ('cloture', 'nouvelle_intervention'));
$$;

create or replace function public._client_moi() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select full_name from public.profiles where id = auth.uid();
$$;

-- ---------------------------------------------------------------------
-- 4. DÉCLENCHEURS
-- ---------------------------------------------------------------------

-- Avant écriture : état par défaut, état déduit de la date de pose,
-- date de clôture, auteur.
create or replace function public.client_jobs_avant() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.status := coalesce(new.status, case new.kind when 'pose' then 'a_planifier' else 'a_traiter' end);
    new.created_by := coalesce(new.created_by, auth.uid());
    new.created_name := coalesce(new.created_name, public._client_moi());
  else
    -- Le dossier et la nature d'une fiche ne changent pas : une pose qui
    -- devient un SAV est une NOUVELLE fiche, reliée à la pose.
    new.file_id := old.file_id;
    new.kind := old.kind;
    new.created_by := old.created_by;
    new.created_name := old.created_name;
    new.created_at := old.created_at;
  end if;

  -- Une pose qui reçoit sa date est planifiée ; qui la perd ne l'est plus.
  if new.kind = 'pose' then
    if new.pose_date is not null and new.status = 'a_planifier' then new.status := 'planifiee'; end if;
    if new.pose_date is null and new.status = 'planifiee' then new.status := 'a_planifier'; end if;
  end if;

  -- Clôturée quand elle atteint un état final ; la date ne bouge plus ensuite.
  if public.client_job_terminal(new.kind, new.status) then
    new.closed_at := case when tg_op = 'UPDATE' and public.client_job_terminal(old.kind, old.status)
                          then old.closed_at else now() end;
  else
    new.closed_at := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists client_jobs_avant on public.client_jobs;
create trigger client_jobs_avant before insert or update on public.client_jobs
  for each row execute function public.client_jobs_avant();

-- Après écriture : le fil.
create or replace function public.client_jobs_fil() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_fiche text := case new.kind when 'pose' then 'Pose' else 'SAV' end;
  v_lignes text[] := '{}';
  v_moi text := public._client_moi();
begin
  if tg_op = 'INSERT' then
    v_lignes := array[
      'Fiche ' || case new.kind when 'pose' then 'pose' else 'SAV' end || ' créée'
      || case when new.parent_id is not null then ' (suite de la fiche précédente)' else '' end
      || case new.source when 'telephone' then ' — signalé par téléphone'
                         when 'magasin'   then ' — signalé au magasin'
                         when 'mail'      then ' — signalé par mail'
                         else '' end
      || case when coalesce(btrim(new.title), '') <> '' then ' : ' || btrim(new.title) else '' end];
  else
    if new.status is distinct from old.status then
      v_lignes := v_lignes || (v_fiche || ' : ' || public.client_status_label(old.kind, old.status)
                               || ' → ' || public.client_status_label(new.kind, new.status));
    end if;
    if new.delivery_date is distinct from old.delivery_date then
      v_lignes := v_lignes || ('Livraison ' || case
        when new.delivery_date is null then 'retirée (était le ' || to_char(old.delivery_date, 'DD/MM/YYYY') || ')'
        when old.delivery_date is null then 'fixée au ' || to_char(new.delivery_date, 'DD/MM/YYYY')
        else 'déplacée du ' || to_char(old.delivery_date, 'DD/MM/YYYY') || ' au ' || to_char(new.delivery_date, 'DD/MM/YYYY') end);
    end if;
    if new.pose_date is distinct from old.pose_date then
      v_lignes := v_lignes || ('Pose ' || case
        when new.pose_date is null then 'retirée (était le ' || to_char(old.pose_date, 'DD/MM/YYYY') || ')'
        when old.pose_date is null then 'fixée au ' || to_char(new.pose_date, 'DD/MM/YYYY')
        else 'déplacée du ' || to_char(old.pose_date, 'DD/MM/YYYY') || ' au ' || to_char(new.pose_date, 'DD/MM/YYYY') end);
    end if;
    if new.intervention_date is distinct from old.intervention_date then
      v_lignes := v_lignes || ('Intervention ' || case
        when new.intervention_date is null then 'retirée (était le ' || to_char(old.intervention_date, 'DD/MM/YYYY') || ')'
        when old.intervention_date is null then 'fixée au ' || to_char(new.intervention_date, 'DD/MM/YYYY')
        else 'déplacée du ' || to_char(old.intervention_date, 'DD/MM/YYYY') || ' au ' || to_char(new.intervention_date, 'DD/MM/YYYY') end);
    end if;
    if new.order_ref is distinct from old.order_ref and coalesce(btrim(new.order_ref), '') <> '' then
      v_lignes := v_lignes || ('Référence de commande : ' || btrim(new.order_ref));
    end if;
  end if;

  if array_length(v_lignes, 1) > 0 then
    insert into public.client_notes (file_id, job_id, body, automatique, author, author_name)
    select new.file_id, new.id, l, true, auth.uid(), v_moi from unnest(v_lignes) l;
    update public.client_files set updated_at = now() where id = new.file_id;
  end if;
  return null;
end;
$$;

drop trigger if exists client_jobs_fil on public.client_jobs;
create trigger client_jobs_fil after insert or update on public.client_jobs
  for each row execute function public.client_jobs_fil();

create or replace function public.client_files_avant() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
    new.created_name := coalesce(new.created_name, public._client_moi());
  else
    new.created_by := old.created_by;
    new.created_name := old.created_name;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists client_files_avant on public.client_files;
create trigger client_files_avant before insert or update on public.client_files
  for each row execute function public.client_files_avant();

-- ---------------------------------------------------------------------
-- 5. GESTES
-- ---------------------------------------------------------------------

-- Nouveau client, en un geste : le dossier, et s'il y a lieu sa première
-- fiche et un premier mot. Seul le nom est obligatoire — le client est au
-- téléphone, on n'a pas le temps de remplir un formulaire.
create or replace function public.client_file_create(
  p_name text, p_phone text default null, p_email text default null,
  p_source text default null, p_kind text default null,
  p_title text default null, p_note text default null,
  p_address text default null
) returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_job uuid;
begin
  if not public.is_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'Le nom du client est obligatoire.';
  end if;
  if p_kind is not null and p_kind not in ('pose', 'sav') then
    raise exception 'Type de fiche inconnu : %', p_kind;
  end if;

  insert into public.client_files (name, phone, email, address, source)
  values (btrim(p_name), nullif(btrim(coalesce(p_phone, '')), ''),
          nullif(lower(btrim(coalesce(p_email, ''))), ''),
          nullif(btrim(coalesce(p_address, '')), ''), nullif(p_source, ''))
  returning id into v_id;

  if p_kind is not null then
    insert into public.client_jobs (file_id, kind, title, source)
    values (v_id, p_kind, nullif(btrim(coalesce(p_title, '')), ''),
            case when p_kind = 'sav' then nullif(p_source, '') end)
    returning id into v_job;
  end if;

  if coalesce(btrim(p_note), '') <> '' then
    insert into public.client_notes (file_id, job_id, body, author, author_name)
    values (v_id, v_job, btrim(p_note), auth.uid(), public._client_moi());
  end if;

  return json_build_object('id', v_id, 'job_id', v_job);
end;
$$;

-- Une fiche de plus dans un dossier existant
create or replace function public.client_job_create(
  p_file uuid, p_kind text, p_title text default null, p_source text default null
) returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if not public.is_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  if p_kind not in ('pose', 'sav') then
    raise exception 'Type de fiche inconnu : %', p_kind;
  end if;
  if not exists (select 1 from public.client_files where id = p_file) then
    raise exception 'Dossier introuvable.';
  end if;
  insert into public.client_jobs (file_id, kind, title, source)
  values (p_file, p_kind, nullif(btrim(coalesce(p_title, '')), ''), nullif(p_source, ''))
  returning id into v_id;
  return json_build_object('id', v_id);
end;
$$;

-- La suite d'une fiche : une pose terminée AVEC un SAV, ou un SAV qui
-- demande une nouvelle intervention. En une transaction : la fiche
-- d'origine prend son état final, la nouvelle fiche SAV naît reliée à
-- elle. Jamais l'un sans l'autre.
create or replace function public.client_job_followup(
  p_job uuid, p_title text default null, p_source text default null
) returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_j public.client_jobs;
  v_id uuid;
begin
  if not public.is_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  select * into v_j from public.client_jobs where id = p_job for update;
  if v_j.id is null then raise exception 'Fiche introuvable.'; end if;
  if v_j.status in ('sav', 'nouvelle_intervention') then
    raise exception 'Cette fiche a déjà une suite.';
  end if;

  update public.client_jobs
     set status = case v_j.kind when 'pose' then 'sav' else 'nouvelle_intervention' end
   where id = p_job;

  insert into public.client_jobs (file_id, kind, title, source, parent_id, order_ref)
  values (v_j.file_id, 'sav',
          coalesce(nullif(btrim(coalesce(p_title, '')), ''),
                   case when v_j.kind = 'sav' then v_j.title end),
          nullif(p_source, ''), v_j.id, null)
  returning id into v_id;

  return json_build_object('id', v_id, 'parent_id', p_job);
end;
$$;

-- Un mot dans le fil du dossier
create or replace function public.client_note_add(
  p_file uuid, p_body text, p_job uuid default null
) returns json language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  if not public.is_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_body), '') = '' then
    raise exception 'La note est vide.';
  end if;
  if not exists (select 1 from public.client_files where id = p_file) then
    raise exception 'Dossier introuvable.';
  end if;
  insert into public.client_notes (file_id, job_id, body, author, author_name)
  values (p_file, p_job, btrim(p_body), auth.uid(), public._client_moi());
  update public.client_files set updated_at = now() where id = p_file;
  return json_build_object('ok', true);
end;
$$;

-- Tous les dossiers, avec leurs fiches et leur dernier mot : de quoi
-- afficher la liste et la filtrer sans aller-retour. Le fil complet ne se
-- charge qu'à l'ouverture d'un dossier.
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
               order by n.created_at desc limit 1) as last_note
        from public.client_files f
       where public.is_member()
    ) d;
$$;

revoke all on function public.client_file_create(text, text, text, text, text, text, text, text) from public;
revoke all on function public.client_job_create(uuid, text, text, text) from public;
revoke all on function public.client_job_followup(uuid, text, text) from public;
revoke all on function public.client_note_add(uuid, text, uuid) from public;
revoke all on function public.client_file_list() from public;
revoke all on function public._client_moi() from public;
grant execute on function public.client_file_create(text, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.client_job_create(uuid, text, text, text) to authenticated;
grant execute on function public.client_job_followup(uuid, text, text) to authenticated;
grant execute on function public.client_note_add(uuid, text, uuid) to authenticated;
grant execute on function public.client_file_list() to authenticated;
