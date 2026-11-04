-- =====================================================================
-- 0042 — Les vendeurs, le relais entre collègues, la trace de qui fait quoi
--
-- 1. LES VENDEURS (Bob Tilkin, Marie Closson). Ils créent et suivent les
--    dossiers clients — poses, SAV, mesurages, autres demandes — et
--    écrivent aux clients. La comptabilité leur reste fermée : factures,
--    fournisseurs, paiements, pièces jointes, mémoire, réglages.
--
--    Plutôt que de reprendre une à une les quarante règles d'accès de la
--    comptabilité, on change le SENS de is_member() : il veut désormais
--    dire « du bureau » (gérant ou secrétaire). Tout ce qui existait reste
--    donc fermé aux vendeurs, sans exception oubliée — y compris les
--    pièces jointes du stockage. La partie clients, la liste à faire et
--    l'annuaire de l'équipe passent à is_client_member(), qui inclut les
--    vendeurs. Le défaut est la fermeture : une table ajoutée demain sur
--    is_member() ne s'ouvrira pas aux vendeurs par mégarde.
--
-- 2. LE RELAIS. Un dossier se confie à quelqu'un — Marie au bureau, un
--    vendeur — avec une consigne, urgente ou non. Il répond « traité » ou
--    « pas traité » d'un geste, avec un mot ; celui qui a confié lit la
--    réponse et classe. Un relais à la fois par dossier ; le fil garde
--    chaque consigne et chaque réponse.
--
-- 3. LA TRACE. Le fil notait les étapes et les dates. Il note désormais
--    aussi les textes modifiés (objet, remarques, coordonnées, reste à
--    faire), avec leur auteur ; et chaque dossier, chaque fiche, garde qui
--    l'a modifié en dernier.
--
-- 4. DEUX SORTES DE FICHE de plus : le mesurage (à planifier, planifié,
--    fait) et l'autre demande (à traiter, en cours, traitée).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. LE RÔLE VENDEUR
-- ---------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('manager', 'secretary', 'seller'));

-- Tout compte de l'équipe, vendeurs compris : la partie clients
create or replace function public.is_client_member() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid());
$$;

-- ---------------------------------------------------------------------
-- 2. COLONNES
-- ---------------------------------------------------------------------
alter table public.client_files
  add column if not exists relais           text,
  add column if not exists relais_consigne  text,
  add column if not exists relais_reponse   text,
  add column if not exists relais_par_name  text,
  add column if not exists relais_le        timestamptz,
  add column if not exists relais_de        uuid references auth.users,
  add column if not exists relais_de_name   text,
  add column if not exists relais_pour      uuid references auth.users,
  add column if not exists relais_pour_name text,
  add column if not exists relais_urgent    boolean not null default false,
  add column if not exists updated_by       uuid references auth.users,
  add column if not exists updated_name     text;

alter table public.client_files drop constraint if exists client_files_relais_ck;
alter table public.client_files add constraint client_files_relais_ck
  check (relais is null or relais in ('a_traiter', 'traite', 'non_traite'));

create index if not exists client_files_relais_idx on public.client_files (relais_pour)
  where relais is not null;

alter table public.client_jobs
  add column if not exists updated_by   uuid references auth.users,
  add column if not exists updated_name text,
  -- Quand le client est joignable, quand on peut passer : ce que le
  -- vendeur note au magasin pour que le mesurage se planifie sans rappel.
  add column if not exists preferences  text;

-- Mesurage et autre demande
alter table public.client_jobs drop constraint if exists client_jobs_kind_check;
alter table public.client_jobs add constraint client_jobs_kind_check
  check (kind in ('pose', 'sav', 'mesure', 'demande'));
alter table public.client_jobs drop constraint if exists client_jobs_status_ck;
alter table public.client_jobs add constraint client_jobs_status_ck check (
  (kind = 'pose' and status in ('a_planifier', 'planifiee', 'terminee', 'sav'))
  or (kind = 'sav' and status in ('a_traiter', 'commande', 'recu', 'planifie', 'cloture', 'nouvelle_intervention'))
  or (kind = 'mesure' and status in ('a_planifier', 'planifiee', 'faite'))
  or (kind = 'demande' and status in ('a_traiter', 'en_cours', 'traitee'))
);

-- ---------------------------------------------------------------------
-- 3. LIBELLÉS ET ÉTATS FINAUX
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
    when 'mesure:a_planifier'        then 'À planifier'
    when 'mesure:planifiee'          then 'Planifié'
    when 'mesure:faite'              then 'Fait'
    when 'demande:a_traiter'         then 'À traiter'
    when 'demande:en_cours'          then 'En cours'
    when 'demande:traitee'           then 'Traitée'
    else p_status end;
$$;

create or replace function public.client_job_terminal(p_kind text, p_status text)
returns boolean language sql immutable as $$
  select (p_kind = 'pose' and p_status in ('terminee', 'sav'))
      or (p_kind = 'sav'  and p_status in ('cloture', 'nouvelle_intervention'))
      or (p_kind = 'mesure' and p_status = 'faite')
      or (p_kind = 'demande' and p_status = 'traitee');
$$;

-- ---------------------------------------------------------------------
-- 4. DÉCLENCHEURS
-- ---------------------------------------------------------------------
create or replace function public.client_jobs_avant() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.status := coalesce(new.status, case when new.kind in ('pose', 'mesure') then 'a_planifier' else 'a_traiter' end);
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
    new.updated_by := coalesce(auth.uid(), old.updated_by);
    new.updated_name := coalesce(public._client_moi(), old.updated_name);
  end if;

  -- Une pose qui reçoit sa date est planifiée ; qui la perd ne l'est plus.
  if new.kind = 'pose' then
    if new.pose_date is not null and new.status = 'a_planifier' then new.status := 'planifiee'; end if;
    if new.pose_date is null and new.status = 'planifiee' then new.status := 'a_planifier'; end if;
  end if;
  -- Pareil pour un mesurage et sa date
  if new.kind = 'mesure' then
    if new.intervention_date is not null and new.status = 'a_planifier' then new.status := 'planifiee'; end if;
    if new.intervention_date is null and new.status = 'planifiee' then new.status := 'a_planifier'; end if;
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

create or replace function public.client_jobs_fil() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_fiche text := case new.kind when 'pose' then 'Pose' when 'sav' then 'SAV'
                                when 'mesure' then 'Mesurage' else 'Demande' end;
  -- La date d'une fiche SAV est une intervention ; celle d'un mesurage, le
  -- mesurage — au masculin : « fixé », « déplacé », « retiré ».
  v_date text := case new.kind when 'mesure' then 'Mesurage' else 'Intervention' end;
  v_e    text := case new.kind when 'mesure' then '' else 'e' end;
  v_lignes text[] := '{}';
  v_moi text := public._client_moi();
begin
  if tg_op = 'INSERT' then
    v_lignes := array[
      'Fiche ' || case new.kind when 'pose' then 'pose' when 'sav' then 'SAV'
                                when 'mesure' then 'mesurage' else 'demande' end || ' créée'
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
      v_lignes := v_lignes || (v_date || ' ' || case
        when new.intervention_date is null then 'retiré' || v_e || ' (était le ' || to_char(old.intervention_date, 'DD/MM/YYYY') || ')'
        when old.intervention_date is null then 'fixé' || v_e || ' au ' || to_char(new.intervention_date, 'DD/MM/YYYY')
        else 'déplacé' || v_e || ' du ' || to_char(old.intervention_date, 'DD/MM/YYYY') || ' au ' || to_char(new.intervention_date, 'DD/MM/YYYY') end);
    end if;
    if new.order_ref is distinct from old.order_ref and coalesce(btrim(new.order_ref), '') <> '' then
      v_lignes := v_lignes || ('Référence de commande : ' || btrim(new.order_ref));
    end if;
    -- Les textes : qui a écrit quoi
    if coalesce(btrim(new.title), '') is distinct from coalesce(btrim(old.title), '') then
      v_lignes := v_lignes || (case when coalesce(btrim(new.title), '') = '' then 'Objet effacé'
                                    else 'Objet modifié : ' || btrim(new.title) end);
    end if;
    if coalesce(btrim(new.preferences), '') is distinct from coalesce(btrim(old.preferences), '') then
      v_lignes := v_lignes || (case when coalesce(btrim(new.preferences), '') = '' then 'Disponibilités effacées'
                                    else 'Disponibilités du client : ' || left(btrim(new.preferences), 300) end);
    end if;
    if coalesce(btrim(new.remarks), '') is distinct from coalesce(btrim(old.remarks), '') then
      v_lignes := v_lignes || (case when coalesce(btrim(new.remarks), '') = '' then 'Remarques effacées'
                                    else 'Remarques modifiées : ' || left(btrim(new.remarks), 300) end);
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

-- Le dossier : qui l'a modifié en dernier — seulement quand on touche à
-- ce qu'il dit, pas quand une fiche ou un relais le remet à l'heure.
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
    if (new.name, new.phone, new.email, new.address, new.todo)
       is distinct from (old.name, old.phone, old.email, old.address, old.todo) then
      new.updated_by := coalesce(auth.uid(), old.updated_by);
      new.updated_name := coalesce(public._client_moi(), old.updated_name);
    else
      new.updated_by := old.updated_by;
      new.updated_name := old.updated_name;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.client_files_fil() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_quoi text[] := '{}';
  v_lignes text[] := '{}';
begin
  if new.name    is distinct from old.name    then v_quoi := v_quoi || 'nom'::text; end if;
  if new.phone   is distinct from old.phone   then v_quoi := v_quoi || 'téléphone'::text; end if;
  if new.email   is distinct from old.email   then v_quoi := v_quoi || 'e-mail'::text; end if;
  if new.address is distinct from old.address then v_quoi := v_quoi || 'adresse'::text; end if;
  if array_length(v_quoi, 1) > 0 then
    v_lignes := v_lignes || ('Coordonnées modifiées : ' || array_to_string(v_quoi, ', '));
  end if;
  if coalesce(btrim(new.todo), '') is distinct from coalesce(btrim(old.todo), '') then
    v_lignes := v_lignes || (case when coalesce(btrim(new.todo), '') = '' then 'Reste à faire effacé'
                                  else 'Reste à faire : ' || left(btrim(new.todo), 300) end);
  end if;
  if array_length(v_lignes, 1) > 0 then
    insert into public.client_notes (file_id, body, automatique, author, author_name)
    select new.id, l, true, auth.uid(), public._client_moi() from unnest(v_lignes) l;
  end if;
  return null;
end;
$$;

drop trigger if exists client_files_fil on public.client_files;
create trigger client_files_fil after update on public.client_files
  for each row execute function public.client_files_fil();

-- ---------------------------------------------------------------------
-- 5. ACCÈS À LA PARTIE CLIENTS : vendeurs compris
-- ---------------------------------------------------------------------
drop policy if exists client_files_read on public.client_files;
create policy client_files_read on public.client_files for select using (public.is_client_member());
drop policy if exists client_files_insert on public.client_files;
create policy client_files_insert on public.client_files for insert with check (public.is_client_member());
drop policy if exists client_files_update on public.client_files;
create policy client_files_update on public.client_files for update using (public.is_client_member()) with check (public.is_client_member());

drop policy if exists client_jobs_read on public.client_jobs;
create policy client_jobs_read on public.client_jobs for select using (public.is_client_member());
drop policy if exists client_jobs_insert on public.client_jobs;
create policy client_jobs_insert on public.client_jobs for insert with check (public.is_client_member());
drop policy if exists client_jobs_update on public.client_jobs;
create policy client_jobs_update on public.client_jobs for update using (public.is_client_member()) with check (public.is_client_member());

drop policy if exists client_notes_read on public.client_notes;
create policy client_notes_read on public.client_notes for select using (public.is_client_member());

-- Les gestes de la partie clients, repris de 0041 avec le nouveau droit
-- et les deux nouvelles sortes de fiche.
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
  if not public.is_client_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'Le nom du client est obligatoire.';
  end if;
  if p_kind is not null and p_kind not in ('pose', 'sav', 'mesure', 'demande') then
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
            case when p_kind <> 'pose' then nullif(p_source, '') end)
    returning id into v_job;
  end if;

  if coalesce(btrim(p_note), '') <> '' then
    insert into public.client_notes (file_id, job_id, body, author, author_name)
    values (v_id, v_job, btrim(p_note), auth.uid(), public._client_moi());
  end if;

  return json_build_object('id', v_id, 'job_id', v_job);
end;
$$;

create or replace function public.client_job_create(
  p_file uuid, p_kind text, p_title text default null, p_source text default null
) returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if not public.is_client_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  if p_kind not in ('pose', 'sav', 'mesure', 'demande') then
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

create or replace function public.client_job_followup(
  p_job uuid, p_title text default null, p_source text default null
) returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_j public.client_jobs;
  v_id uuid;
begin
  if not public.is_client_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  select * into v_j from public.client_jobs where id = p_job for update;
  if v_j.id is null then raise exception 'Fiche introuvable.'; end if;
  if v_j.kind not in ('pose', 'sav') then
    raise exception 'Seules une pose ou un SAV ont une suite SAV.';
  end if;
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

create or replace function public.client_note_add(
  p_file uuid, p_body text, p_job uuid default null
) returns json language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  if not public.is_client_member() then
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
       where public.is_client_member()
    ) d;
$$;

-- ---------------------------------------------------------------------
-- 6. LE RELAIS
-- ---------------------------------------------------------------------
--   p_etat 'a_traiter'  : confier à p_pour (p_texte = la consigne ; vide =
--                         « ce qu'il reste à faire »), urgent ou non
--   p_etat 'traite'     : traité (p_texte = un mot facultatif)
--   p_etat 'non_traite' : pas traité (p_texte = pourquoi, facultatif)
--   p_etat 'classe'     : le retour est lu, le relais se referme
create or replace function public.client_relais(
  p_file uuid, p_etat text, p_texte text default null,
  p_pour uuid default null, p_urgent boolean default false
) returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_moi    text := public._client_moi();
  v_texte  text := nullif(btrim(coalesce(p_texte, '')), '');
  v_f      public.client_files%rowtype;
  v_lui    text;
  v_note   text;
begin
  if not public.is_client_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  if p_etat not in ('a_traiter', 'traite', 'non_traite', 'classe') then
    raise exception 'Geste inconnu : %', p_etat;
  end if;

  select * into v_f from public.client_files where id = p_file for update;
  if not found then
    raise exception 'Ce dossier n''existe plus.';
  end if;

  if p_etat = 'a_traiter' then
    select full_name into v_lui from public.profiles where id = p_pour;
    if p_pour is null or v_lui is null then
      raise exception 'Choisis à qui confier ce dossier.';
    end if;
    v_texte := coalesce(v_texte, nullif(btrim(coalesce(v_f.todo, '')), ''));
    if v_texte is null then
      raise exception 'Écris ce qu''il faut faire : la consigne est vide.';
    end if;
    update public.client_files
       set relais = 'a_traiter', relais_consigne = v_texte, relais_reponse = null,
           relais_de = auth.uid(), relais_de_name = v_moi,
           relais_pour = p_pour, relais_pour_name = v_lui,
           relais_urgent = coalesce(p_urgent, false),
           relais_par_name = v_moi, relais_le = now()
     where id = p_file;
    v_note := case when coalesce(p_urgent, false) then 'URGENT — ' else '' end
              || 'À traiter par ' || v_lui || ' : ' || v_texte;

  elsif p_etat in ('traite', 'non_traite') then
    if v_f.relais is null then
      raise exception 'Rien n''est en attente sur ce dossier.';
    end if;
    update public.client_files
       set relais = p_etat, relais_reponse = v_texte, relais_urgent = false,
           relais_par_name = v_moi, relais_le = now()
     where id = p_file;
    v_note := case p_etat when 'traite' then 'Traité' else 'Pas traité' end
              || coalesce(' — ' || v_texte, '');

  else
    update public.client_files
       set relais = null, relais_urgent = false, relais_le = now(), relais_par_name = v_moi
     where id = p_file;
    -- Classer ne dit rien de neuf : pas de ligne dans le fil.
    return json_build_object('id', p_file, 'relais', null);
  end if;

  insert into public.client_notes (file_id, body, automatique, author, author_name)
  values (p_file, v_note, false, auth.uid(), v_moi);

  return json_build_object('id', p_file, 'relais', p_etat);
end;
$$;

-- Plusieurs dossiers d'un coup, chacun avec son « reste à faire » pour
-- consigne. Les dossiers sans reste à faire, ou déjà confiés, sont laissés.
create or replace function public.client_relais_lot(
  p_files uuid[], p_pour uuid, p_urgent boolean default false
) returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_n  int := 0;
begin
  if not public.is_client_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  for v_id in
    select f.id from public.client_files f
     where f.id = any(p_files)
       and f.relais is distinct from 'a_traiter'
       and nullif(btrim(coalesce(f.todo, '')), '') is not null
  loop
    perform public.client_relais(v_id, 'a_traiter', null, p_pour, p_urgent);
    v_n := v_n + 1;
  end loop;
  return json_build_object('confies', v_n);
end;
$$;

-- Ce que la pastille du menu affiche, pour qui regarde
create or replace function public.client_relais_count()
returns json language sql stable security definer
set search_path = public, pg_temp as $$
  select json_build_object(
    'a_traiter', count(*) filter (where relais = 'a_traiter' and relais_pour = auth.uid()),
    'urgents',   count(*) filter (where relais = 'a_traiter' and relais_pour = auth.uid() and relais_urgent),
    'reponses',  count(*) filter (where relais in ('traite', 'non_traite') and relais_de = auth.uid())
  ) from public.client_files where public.is_client_member();
$$;

-- ---------------------------------------------------------------------
-- 7. L'ÉQUIPE ET LA LISTE À FAIRE, vendeurs compris
-- ---------------------------------------------------------------------
-- L'annuaire : un identifiant, un nom, et le rôle — pour proposer « à qui
-- confier » et distinguer les deux Marie.
create or replace function public.equipe()
returns json language sql stable security definer
set search_path = public, pg_temp as $$
  select coalesce(json_agg(json_build_object('id', p.id, 'full_name', p.full_name, 'role', p.role)
                           order by p.full_name), '[]'::json)
    from public.profiles p
   where public.is_client_member();
$$;

-- Un vendeur ne voit que les tâches qui le concernent : celles qu'on lui
-- confie et celles qu'il a créées. Le bureau voit tout, comme avant.
create or replace function public.task_visible(p_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_member()
      or (public.is_client_member() and exists (
            select 1 from public.tasks t
             where t.id = p_id and (t.assigned_to = auth.uid() or t.created_by = auth.uid())));
$$;

drop policy if exists tasks_read on public.tasks;
create policy tasks_read on public.tasks for select
  using (public.is_member() or (public.is_client_member() and (assigned_to = auth.uid() or created_by = auth.uid())));
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert with check (public.is_client_member());
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update
  using (public.task_visible(id)) with check (public.is_client_member());
drop policy if exists comments_read on public.task_comments;
create policy comments_read on public.task_comments for select using (public.task_visible(task_id));
drop policy if exists comments_insert on public.task_comments;
create policy comments_insert on public.task_comments for insert with check (public.task_visible(task_id));

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
  if not public.is_client_member() then
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
       where public.task_visible(k.id)
         and (p_closes or k.status = 'a_faire')
    ) t;
$$;

create or replace function public.task_count()
returns json language sql stable security definer
set search_path = public, pg_temp as $$
  select json_build_object(
    'a_faire',   count(*) filter (where status = 'a_faire'),
    'en_retard', count(*) filter (where status = 'a_faire' and due_date is not null and due_date < current_date),
    'pour_moi',  count(*) filter (where status = 'a_faire' and assigned_to = auth.uid()),
    'du_gerant', count(*) filter (where status = 'a_faire' and origine = 'gerant')
  ) from public.tasks t where public.task_visible(t.id);
$$;

create or replace function public.task_set_status(
  p_id uuid, p_status text, p_note text default null
) returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_moi text;
  v_avant text;
begin
  if not public.task_visible(p_id) then
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

create or replace function public.task_postpone(p_id uuid, p_due date, p_note text default null)
returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_moi text;
  v_n int;
begin
  if not public.task_visible(p_id) then
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

create or replace function public.task_comment(p_id uuid, p_body text)
returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_moi text;
begin
  if not public.task_visible(p_id) then
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
-- 8. LE BUREAU : is_member() ne compte plus que le gérant et la secrétaire
-- ---------------------------------------------------------------------
-- En dernier, une fois la partie clients passée sur son propre droit.
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.profiles p
                  where p.id = auth.uid() and p.role in ('manager', 'secretary'));
$$;

-- ---------------------------------------------------------------------
-- 9. DROITS D'EXÉCUTION
-- ---------------------------------------------------------------------
drop function if exists public.client_relais(uuid, text, text);
drop function if exists public.client_relais_lot(uuid[]);
revoke all on function public.is_client_member() from public;
revoke all on function public.task_visible(uuid) from public;
revoke all on function public.client_relais(uuid, text, text, uuid, boolean) from public;
revoke all on function public.client_relais_lot(uuid[], uuid, boolean) from public;
revoke all on function public.client_relais_count() from public;
grant execute on function public.is_client_member() to authenticated;
grant execute on function public.task_visible(uuid) to authenticated;
grant execute on function public.client_relais(uuid, text, text, uuid, boolean) to authenticated;
grant execute on function public.client_relais_lot(uuid[], uuid, boolean) to authenticated;
grant execute on function public.client_relais_count() to authenticated;
