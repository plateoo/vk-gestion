-- =====================================================================
-- VK Gestion — des documents dans la mémoire
--
-- Jordan : « sur la partie mémoire, on peut y ajouter des documents PDF ?
-- Exemple document d'utilisation du logiciel Cubehic ? et toute autre
-- information utile que l'on peut recevoir en PDF. »
--
-- Le besoin est juste et il complète exactement ce que la mémoire fait
-- déjà. Une fiche écrite dit « comment on fait ici » ; le mode d'emploi du
-- fournisseur dit « comment l'outil fonctionne ». Les deux se cherchent au
-- même moment, et aujourd'hui le second dort dans une boîte mail que le
-- remplaçant n'aura pas.
--
-- Un espace de stockage à part, et non le bucket des factures : ces
-- documents n'ont ni le même cycle de vie, ni les mêmes règles. Les
-- factures sont écrites par le serveur et purgées avec la quarantaine ;
-- ceux-ci sont déposés à la main et destinés à rester des années.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. L'espace de stockage
--
-- Privé, comme tout le reste : on n'ouvre rien au public, pas même un
-- mode d'emploi. Le plafond par fichier et la liste des types sont posés
-- ICI, côté serveur : une limite qui ne vit que dans le navigateur n'est
-- pas une limite.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('memoire', 'memoire', false, 26214400, array[
  'application/pdf',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic',
  'text/plain', 'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Lecture et dépôt pour les deux comptes : une mémoire commune se remplit
-- à deux ou ne se remplit pas. La suppression reste au gérant, comme pour
-- les fiches — un document effacé emporte un savoir qu'on ne retrouve pas.
drop policy if exists "memoire read" on storage.objects;
create policy "memoire read" on storage.objects
  for select using (bucket_id = 'memoire' and public.is_member());

drop policy if exists "memoire insert" on storage.objects;
create policy "memoire insert" on storage.objects
  for insert with check (bucket_id = 'memoire' and public.is_member());

drop policy if exists "memoire delete" on storage.objects;
create policy "memoire delete" on storage.objects
  for delete using (bucket_id = 'memoire' and public.is_manager());

-- ---------------------------------------------------------------------
-- 2. Ce qui est attaché à quoi
--
-- Une table plutôt qu'une colonne jsonb : on a besoin de supprimer un
-- document précis, de savoir qui l'a déposé, et de retrouver les objets
-- orphelins si une fiche disparaît. Un tableau JSON rendrait les trois
-- pénibles.
-- ---------------------------------------------------------------------
create table if not exists public.memo_files (
  id          uuid primary key default gen_random_uuid(),
  memo_id     uuid not null references public.memo(id) on delete cascade,
  -- Chemin dans le bucket. Unique : deux fiches ne partagent jamais un
  -- objet, sinon supprimer l'une casserait l'autre.
  path        text not null unique,
  -- Le nom tel que l'utilisateur le voit. Le chemin, lui, est nettoyé et
  -- préfixé d'un identifiant : deux « manuel.pdf » doivent pouvoir
  -- coexister sans que le second écrase le premier.
  name        text not null check (btrim(name) <> ''),
  mime        text,
  size_bytes  bigint,
  added_by    uuid references auth.users,
  added_name  text,
  created_at  timestamptz not null default now()
);

create index if not exists memo_files_memo_idx on public.memo_files (memo_id, created_at);

alter table public.memo_files enable row level security;

drop policy if exists memo_files_read on public.memo_files;
create policy memo_files_read on public.memo_files for select using (public.is_member());
drop policy if exists memo_files_insert on public.memo_files;
create policy memo_files_insert on public.memo_files for insert with check (public.is_member());
drop policy if exists memo_files_delete on public.memo_files;
create policy memo_files_delete on public.memo_files for delete using (public.is_manager());

-- ---------------------------------------------------------------------
-- 3. Rattacher un document déposé
--
-- Le dépôt lui-même se fait par le navigateur, directement vers le
-- stockage. Cette fonction enregistre seulement le lien — et refuse un
-- chemin qui ne serait pas réellement présent dans le bucket, pour qu'une
-- ligne ne pointe jamais vers le vide.
-- ---------------------------------------------------------------------
create or replace function public.memo_file_add(
  p_memo uuid, p_path text, p_name text,
  p_mime text default null, p_size bigint default null
) returns json language plpgsql security definer
set search_path = public, storage, pg_temp as $$
declare
  v_id  uuid;
  v_moi text;
begin
  if not public.is_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.memo where id = p_memo) then
    raise exception 'Fiche introuvable.';
  end if;
  if coalesce(btrim(coalesce(p_path, '')), '') = '' then
    raise exception 'Chemin de document manquant.';
  end if;
  if not exists (select 1 from storage.objects
                  where bucket_id = 'memoire' and name = p_path) then
    raise exception 'Le document n''a pas été déposé : rien à rattacher.';
  end if;

  select full_name into v_moi from public.profiles where id = auth.uid();

  insert into public.memo_files (memo_id, path, name, mime, size_bytes, added_by, added_name)
  values (p_memo, p_path,
          coalesce(nullif(btrim(coalesce(p_name, '')), ''), 'document'),
          p_mime, p_size, auth.uid(), v_moi)
  returning id into v_id;

  update public.memo set updated_at = now(), updated_by = auth.uid(), updated_name = v_moi
   where id = p_memo;

  return json_build_object('id', v_id);
end;
$$;

/**
 * Détacher un document, et rendre son chemin pour que l'appelant efface
 * l'objet. La ligne part d'abord : mieux vaut un objet orphelin dans le
 * stockage qu'une fiche qui promet un document introuvable.
 */
create or replace function public.memo_file_remove(p_id uuid)
returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_path text;
begin
  if not public.is_manager() then
    raise exception 'Seul le gérant peut retirer un document.' using errcode = '42501';
  end if;
  delete from public.memo_files where id = p_id returning path into v_path;
  if v_path is null then raise exception 'Document introuvable.'; end if;
  return json_build_object('path', v_path);
end;
$$;

-- ---------------------------------------------------------------------
-- 4. La liste, documents compris
-- ---------------------------------------------------------------------
create or replace function public.memo_list()
returns json language sql stable security definer
set search_path = public, pg_temp as $$
  select coalesce(json_agg(m order by m.epingle desc, m.theme, m.title), '[]'::json)
    from (
      select id, title, body, theme, epingle, updated_name, updated_at,
             coalesce((
               select json_agg(f order by f.created_at)
                 from (select id, path, name, mime, size_bytes, added_name, created_at
                         from public.memo_files where memo_id = memo.id
                        order by created_at) f), '[]'::json) as fichiers
        from public.memo where public.is_member()) m;
$$;

/**
 * Les objets du bucket que plus aucune fiche ne réclame.
 *
 * Supprimer une fiche efface ses lignes en cascade, mais pas les objets :
 * le stockage vit en dehors de la base. Sans cette liste, on paierait
 * pour des documents que personne ne peut plus ouvrir.
 */
create or replace function public.memoire_orphelins()
returns json language sql stable security definer
set search_path = public, storage, pg_temp as $$
  select coalesce(json_agg(o order by o.created_at), '[]'::json) from (
    select name as path, created_at,
           (metadata->>'size')::bigint as size_bytes
      from storage.objects
     where bucket_id = 'memoire'
       and public.is_manager()
       and not exists (select 1 from public.memo_files f where f.path = storage.objects.name)
  ) o;
$$;

revoke all on function public.memo_file_add(uuid, text, text, text, bigint) from public;
revoke all on function public.memo_file_remove(uuid) from public;
revoke all on function public.memo_list() from public;
revoke all on function public.memoire_orphelins() from public;

grant execute on function public.memo_file_add(uuid, text, text, text, bigint) to authenticated;
grant execute on function public.memo_file_remove(uuid) to authenticated;
grant execute on function public.memo_list() to authenticated;
grant execute on function public.memoire_orphelins() to authenticated;

-- ---------------------------------------------------------------------
-- 5. Le compteur de stockage englobe les deux espaces
--
-- L'écran d'administration annonçait la place occupée par les factures
-- seules. Des modes d'emploi de plusieurs mégaoctets s'y ajoutent
-- désormais : un chiffre qui ne compte que la moitié du stockage
-- rassurerait à tort.
--
-- Le reste de la fonction est repris mot pour mot de 0019 : seules les
-- trois lignes de stockage changent. Une fonction de tableau de bord se
-- réécrit de mémoire au prix d'un écran cassé.
-- ---------------------------------------------------------------------
create or replace function public.system_status()
returns json language sql stable as $$
  select json_build_object(
    'quarantaine',      (select count(*) from public.inbound_queue where status = 'quarantine'),
    'en_attente',       (select count(*) from public.inbound_queue where status in ('pending','processing')),
    'en_erreur',        (select count(*) from public.inbound_queue where status = 'error'),
    'traites',          (select count(*) from public.inbound_queue where status = 'done'),
    'derniere_reception', (select max(created_at) from public.inbound_queue),
    'a_controler',      (select count(*) from public.invoices where review_status = 'a_controler'),
    'factures',         (select count(*) from public.invoices),
    'fournisseurs',     (select count(*) from public.suppliers),
    'fiches_a_valider', (select count(*) from public.suppliers where needs_review),
    'expediteurs_autorises', (select count(*) from public.allowed_senders),
    -- MODIFIÉ : les deux espaces, pas seulement les factures.
    'stockage_octets',  (select coalesce(sum((metadata->>'size')::bigint), 0)
                           from storage.objects where bucket_id in ('factures', 'memoire')),
    'stockage_fichiers',(select count(*) from storage.objects where bucket_id in ('factures', 'memoire')),
    -- NOUVEAU : ce que pèsent à eux seuls les documents de la mémoire.
    'stockage_memoire', (select coalesce(sum((metadata->>'size')::bigint), 0)
                           from storage.objects where bucket_id = 'memoire'),
    'erreurs_extraction', coalesce((
      select json_agg(e order by e.quand desc) from (
        select q.sender_email, q.subject, q.error, q.processed_at as quand, q.attempts
          from public.inbound_queue q
         where q.status = 'error'
         order by q.processed_at desc nulls last
         limit 10
      ) e), '[]'::json),
    'sans_facture',     (select count(*) from public.inbound_queue where status = 'sans_facture'),
    'messages_sans_facture', coalesce((
      select json_agg(m order by m.quand desc) from (
        select q.sender_email, q.subject, q.received_at as quand,
               coalesce((select string_agg(f->>'name', ', ')
                           from jsonb_array_elements(q.files) f), 'aucune pièce jointe') as pieces
          from public.inbound_queue q
         where q.status = 'sans_facture'
         order by q.received_at desc
         limit 20
      ) m), '[]'::json)
  );
$$;
grant execute on function public.system_status() to authenticated;
