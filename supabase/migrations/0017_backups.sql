-- =====================================================================
-- VK Gestion — sauvegardes
--
-- Deux protections, contre deux risques différents. Il faut les deux :
--
--   1. INSTANTANÉ DANS LA BASE, tous les jours, automatique.
--      Protège du geste malheureux — une facture supprimée par erreur,
--      un lot effacé. C'est le risque réel, et il vient d'augmenter :
--      la corbeille est désormais dans chaque ligne.
--      Aucun secret à gérer : tout se passe dans Postgres, rien ne sort.
--
--   2. ARCHIVE TÉLÉCHARGÉE, gardée ailleurs, par le gérant.
--      Protège de la perte du projet lui-même. Un instantané rangé dans
--      la base qu'il protège ne sert à rien le jour où cette base
--      disparaît. L'application réclame donc ce téléchargement et dit
--      depuis combien de temps il n'a pas été fait.
--
-- Les documents d'origine (166 Mo de PDF) ne sont pas dans l'instantané :
-- ils vivent dans le stockage. Le dossier comptable les emporte, lui.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. LA TABLE DES SAUVEGARDES
-- ---------------------------------------------------------------------
create table if not exists public.backups (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  kind           text not null default 'auto' check (kind in ('auto', 'manuel')),
  payload        jsonb not null,
  row_counts     jsonb not null,
  size_bytes     bigint not null,
  -- Date à laquelle le gérant a emporté cette sauvegarde hors de la base.
  -- C'est elle qui fait foi pour l'alerte : un instantané jamais
  -- téléchargé ne protège pas de la perte du projet.
  downloaded_at  timestamptz,
  note           text
);

create index if not exists backups_date_idx on public.backups (created_at desc);

alter table public.backups enable row level security;

drop policy if exists backups_read on public.backups;
create policy backups_read on public.backups
  for select using (public.is_manager());

drop policy if exists backups_write on public.backups;
create policy backups_write on public.backups
  for update using (public.is_manager()) with check (public.is_manager());

-- Ni insertion ni suppression directes : elles passent par les fonctions,
-- qui seules savent constituer un instantané cohérent.

-- ---------------------------------------------------------------------
-- 2. CONSTITUER UN INSTANTANÉ
--    security definer : appelable par le planificateur comme par le
--    gérant. Le contrôle de rôle se fait à l'intérieur, pour l'appel
--    manuel uniquement — le cron, lui, n'a pas de session.
-- ---------------------------------------------------------------------
create or replace function public.backup_create(p_kind text default 'manuel', p_note text default null)
returns json language plpgsql security definer as $$
declare
  v_payload jsonb;
  v_counts  jsonb;
  v_id      uuid;
  v_taille  bigint;
begin
  if p_kind = 'manuel' and not public.is_manager() then
    raise exception 'Seul le gérant peut lancer une sauvegarde.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'version',    1,
    'fait_le',    now(),
    'suppliers',         coalesce((select jsonb_agg(to_jsonb(t)) from public.suppliers t), '[]'::jsonb),
    'invoices',          coalesce((select jsonb_agg(to_jsonb(t)) from public.invoices t), '[]'::jsonb),
    'profiles',          coalesce((select jsonb_agg(to_jsonb(t)) from public.profiles t), '[]'::jsonb),
    'allowed_senders',   coalesce((select jsonb_agg(to_jsonb(t)) from public.allowed_senders t), '[]'::jsonb),
    'change_log',        coalesce((select jsonb_agg(to_jsonb(t)) from public.change_log t), '[]'::jsonb),
    'inbound_queue',     coalesce((select jsonb_agg(to_jsonb(t)) from public.inbound_queue t), '[]'::jsonb)
  ) into v_payload;

  select jsonb_build_object(
    'suppliers',       (select count(*) from public.suppliers),
    'invoices',        (select count(*) from public.invoices),
    'profiles',        (select count(*) from public.profiles),
    'allowed_senders', (select count(*) from public.allowed_senders),
    'change_log',      (select count(*) from public.change_log),
    'inbound_queue',   (select count(*) from public.inbound_queue)
  ) into v_counts;

  v_taille := octet_length(v_payload::text);

  insert into public.backups (kind, payload, row_counts, size_bytes, note)
  values (coalesce(p_kind, 'manuel'), v_payload, v_counts, v_taille, p_note)
  returning id into v_id;

  perform public.backup_prune();

  return json_build_object('id', v_id, 'taille', v_taille, 'lignes', v_counts);
end;
$$;

-- ---------------------------------------------------------------------
-- 3. MÉNAGE
--    On garde 14 instantanés automatiques et 5 manuels. Sauf ceux qui
--    ont été téléchargés : ceux-là marquent un point de reprise connu du
--    gérant, on ne les efface jamais dans le dos.
-- ---------------------------------------------------------------------
create or replace function public.backup_prune()
returns int language plpgsql security definer as $$
declare v_efface int;
begin
  with classees as (
    select id, row_number() over (partition by kind order by created_at desc) as rang, kind, downloaded_at
      from public.backups
  )
  delete from public.backups b using classees c
   where b.id = c.id
     and c.downloaded_at is null
     and ((c.kind = 'auto' and c.rang > 14) or (c.kind = 'manuel' and c.rang > 5));
  get diagnostics v_efface = row_count;
  return v_efface;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. LISTE, SANS LE CONTENU
--    Le payload pèse quelques mégaoctets : le renvoyer pour afficher une
--    liste ferait ramer l'écran sans rien apporter.
-- ---------------------------------------------------------------------
create or replace function public.backup_list()
returns json language sql stable security definer as $$
  select coalesce(json_agg(b order by b.created_at desc), '[]'::json) from (
    select id, created_at, kind, row_counts, size_bytes, downloaded_at, note
      from public.backups
     where public.is_manager()
  ) b;
$$;

/** Contenu d'une sauvegarde, et marquage du téléchargement. */
create or replace function public.backup_fetch(p_id uuid, p_mark boolean default true)
returns jsonb language plpgsql security definer as $$
declare v jsonb;
begin
  if not public.is_manager() then
    raise exception 'Seul le gérant peut télécharger une sauvegarde.' using errcode = '42501';
  end if;
  select payload into v from public.backups where id = p_id;
  if v is null then raise exception 'Sauvegarde introuvable.'; end if;
  if p_mark then
    update public.backups set downloaded_at = now() where id = p_id;
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. ÉTAT DES SAUVEGARDES — ce que l'écran Administration affiche
-- ---------------------------------------------------------------------
create or replace function public.backup_status()
returns json language sql stable security definer as $$
  select json_build_object(
    'total',            (select count(*) from public.backups),
    'derniere',         (select max(created_at) from public.backups),
    'derniere_taille',  (select size_bytes from public.backups order by created_at desc limit 1),
    'dernier_telechargement', (select max(downloaded_at) from public.backups),
    'heures_depuis',    (select round(extract(epoch from (now() - max(created_at))) / 3600)
                           from public.backups),
    'jours_depuis_telechargement',
                        (select round(extract(epoch from (now() - max(downloaded_at))) / 86400)
                           from public.backups),
    'planifiee',        exists (select 1 from pg_extension where extname = 'pg_cron')
  ) where public.is_manager();
$$;

-- ---------------------------------------------------------------------
-- 6. RENDRE UNE FACTURE SUPPRIMÉE PAR ERREUR
--    Restaurer la base entière serait dangereux et rarement ce qu'on
--    veut. Le besoin réel est étroit : « je viens d'effacer la mauvaise
--    ligne ». On ne réinsère donc qu'une facture, et seulement si elle
--    n'existe plus — jamais d'écrasement d'un travail en cours.
-- ---------------------------------------------------------------------
create or replace function public.backup_restore_invoice(p_backup uuid, p_invoice uuid)
returns json language plpgsql security definer as $$
declare
  v_row      jsonb;
  v_nom      text;
  v_colonnes text;
begin
  if not public.is_manager() then
    raise exception 'Seul le gérant peut restaurer une facture.' using errcode = '42501';
  end if;

  select f into v_row
    from public.backups b, jsonb_array_elements(b.payload -> 'invoices') f
   where b.id = p_backup and (f ->> 'id')::uuid = p_invoice;
  if v_row is null then
    raise exception 'Cette facture ne figure pas dans la sauvegarde choisie.';
  end if;

  if exists (select 1 from public.invoices where id = p_invoice) then
    raise exception 'Cette facture existe toujours : rien à restaurer.';
  end if;
  if not exists (select 1 from public.suppliers where id = (v_row ->> 'supplier_id')::uuid) then
    raise exception 'La fiche fournisseur de cette facture a disparu : restaure-la d''abord.';
  end if;

  -- Les colonnes calculées — amount_tvac, discount_deadline,
  -- amount_discounted — ne se réinsèrent pas : Postgres les recalcule, et
  -- refuse qu'on les lui dicte. Les vider du JSON ne suffit pas : un
  -- « insert ... select * » les nomme quand même, puisqu'elles font partie
  -- du type de la table. On énumère donc les colonnes, et on les lit dans
  -- le catalogue pour que l'ajout d'une colonne calculée ne casse rien.
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_colonnes
    from information_schema.columns
   where table_schema = 'public' and table_name = 'invoices' and is_generated = 'NEVER';

  execute format(
    'insert into public.invoices (%s) select %s from jsonb_populate_record(null::public.invoices, $1)',
    v_colonnes, v_colonnes) using v_row;

  select full_name into v_nom from public.profiles where id = auth.uid();
  insert into public.change_log (entity, entity_id, entity_label, field, old_value, new_value,
                                 reason, author, author_name)
  values ('invoice', p_invoice, coalesce(v_row ->> 'invoice_number', '?'), 'restauration',
          'supprimée', 'restaurée', 'restaurée depuis une sauvegarde', auth.uid(), v_nom);

  return json_build_object('id', p_invoice, 'numero', v_row ->> 'invoice_number');
end;
$$;

-- ---------------------------------------------------------------------
-- 7. DROITS
-- ---------------------------------------------------------------------
revoke all on function public.backup_create(text, text) from public;
revoke all on function public.backup_prune() from public;
revoke all on function public.backup_list() from public;
revoke all on function public.backup_fetch(uuid, boolean) from public;
revoke all on function public.backup_status() from public;
revoke all on function public.backup_restore_invoice(uuid, uuid) from public;

grant execute on function public.backup_create(text, text) to authenticated;
grant execute on function public.backup_list() to authenticated;
grant execute on function public.backup_fetch(uuid, boolean) to authenticated;
grant execute on function public.backup_status() to authenticated;
grant execute on function public.backup_restore_invoice(uuid, uuid) to authenticated;
