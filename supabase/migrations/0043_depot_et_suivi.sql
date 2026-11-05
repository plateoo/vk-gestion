-- =====================================================================
-- 0043 — Déposer une facture à la main, voir les mails sans facture,
--         noter le travail fait sur un dossier client
--
-- 1. LES MAILS SANS PIÈCE LISIBLE. Power Automate relève le dossier
--    Factures tous les quarts d'heure ; un mail sans pièce jointe
--    exploitable y reste, et revient à chaque relève. Au 5 novembre :
--    81 686 lignes de refus pour 293 mails. Le vrai signal — « ce mail de
--    factures n'a rien donné » — était noyé.
--    Un mail = une ligne désormais, avec le nombre de passages. Le bureau
--    les voit dans « À contrôler » et peut les écarter d'un geste.
--
-- 2. LE DÉPÔT À LA MAIN. Quand une facture n'arrive pas par mail (pièce
--    jointe imbriquée, lien, papier), on la dépose dans l'application :
--    elle suit exactement le chemin d'un mail — extraction, rapprochement,
--    file « À contrôler ». L'expéditeur fictif du dépôt est un TRANSITAIRE :
--    son adresse ne sert jamais à rapprocher un fournisseur.
--
-- 3. LE TRAVAIL FAIT SUR UN DOSSIER. « Mail envoyé le 05/11 », « appel le
--    04/11 » : une ligne datée dans le fil, avec sa nature. Et le reste à
--    faire reçoit une échéance et une mention urgente : en retard, il le dit.
--
-- 4. LES DOCUMENTS D'UN DOSSIER (devis, plan, photo), joignables au mail
--    du client par un lien de téléchargement.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Les refus : un mail, une ligne
-- ---------------------------------------------------------------------
alter table public.rejected_messages
  add column if not exists deliveries   int not null default 1,
  add column if not exists last_seen_at timestamptz,
  add column if not exists seen_at      timestamptz,
  add column if not exists seen_by_name text;

-- Les doublons existants : on garde la plus ancienne ligne de chaque mail,
-- avec le compte et la date du dernier passage.
with g as (
  select message_id, reason, min(received_at) premier, max(received_at) dernier, count(*) n,
         (array_agg(id order by received_at, id))[1] garde
    from public.rejected_messages
   where message_id is not null
   group by message_id, reason
)
update public.rejected_messages r
   set deliveries = g.n, last_seen_at = g.dernier
  from g where r.id = g.garde;

delete from public.rejected_messages r
 using (
   select id, row_number() over (partition by message_id, reason order by received_at, id) rang
     from public.rejected_messages where message_id is not null
 ) x
 where r.id = x.id and x.rang > 1;

create unique index if not exists rejected_messages_unique_idx
  on public.rejected_messages (message_id, reason) where message_id is not null;

-- À l'avenir : un nouveau passage du même mail compte, il ne s'ajoute pas.
create or replace function public.rejected_messages_unique() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.message_id is not null then
    update public.rejected_messages
       set deliveries = deliveries + 1, last_seen_at = now(),
           -- une pièce jointe ajoutée entre-temps se voit
           attachment_count = greatest(coalesce(attachment_count, 0), coalesce(new.attachment_count, 0)),
           queue_id = coalesce(new.queue_id, queue_id)
     where message_id = new.message_id and reason = new.reason;
    if found then return null; end if;
  end if;
  new.last_seen_at := coalesce(new.last_seen_at, new.received_at, now());
  return new;
end;
$$;

drop trigger if exists rejected_messages_unique on public.rejected_messages;
create trigger rejected_messages_unique before insert on public.rejected_messages
  for each row execute function public.rejected_messages_unique();

-- Ce que le bureau voit : les mails des 30 derniers jours qui n'ont donné
-- aucune facture faute de pièce lisible, pas encore écartés.
create or replace function public.mails_sans_facture()
returns json language sql stable security definer
set search_path = public, pg_temp as $$
  select coalesce(json_agg(m order by m.recu desc), '[]'::json) from (
    select id, sender_email, subject, received_at recu, last_seen_at, deliveries
      from public.rejected_messages
     where public.is_member()
       and reason = 'aucune pièce jointe exploitable'
       and seen_at is null
       and received_at > now() - interval '30 days'
  ) m;
$$;

create or replace function public.mail_sans_facture_ecarter(p_id uuid)
returns json language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  if not public.is_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  update public.rejected_messages
     set seen_at = now(), seen_by_name = public._client_moi()
   where id = p_id;
  return json_build_object('ok', found);
end;
$$;

-- ---------------------------------------------------------------------
-- 2. L'expéditeur des dépôts à la main : un transitaire
-- ---------------------------------------------------------------------
insert into public.allowed_senders (email, label, is_forwarder)
values ('depot@vk-gestion.app', 'Déposé dans l''application', true)
on conflict (email) do update set is_forwarder = true;

-- ---------------------------------------------------------------------
-- 3. Le travail fait, l'échéance, l'urgence
-- ---------------------------------------------------------------------
alter table public.client_files
  add column if not exists todo_due    date,
  add column if not exists todo_urgent boolean not null default false;

alter table public.client_notes
  add column if not exists work_kind text,
  add column if not exists work_date date;

-- Le fil note aussi l'échéance et l'urgence du reste à faire
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
  if new.todo_due is distinct from old.todo_due then
    v_lignes := v_lignes || (case when new.todo_due is null then 'Échéance retirée'
                                  else 'À faire pour le ' || to_char(new.todo_due, 'DD/MM/YYYY') end);
  end if;
  if new.todo_urgent is distinct from old.todo_urgent then
    v_lignes := v_lignes || (case when new.todo_urgent then 'Marqué urgent' else 'Plus urgent' end);
  end if;
  if array_length(v_lignes, 1) > 0 then
    insert into public.client_notes (file_id, body, automatique, author, author_name)
    select new.id, l, true, auth.uid(), public._client_moi() from unnest(v_lignes) l;
  end if;
  return null;
end;
$$;

-- L'échéance et l'urgence comptent comme une modification du dossier
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
    if (new.name, new.phone, new.email, new.address, new.todo, new.todo_due, new.todo_urgent)
       is distinct from (old.name, old.phone, old.email, old.address, old.todo, old.todo_due, old.todo_urgent) then
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

-- Noter un travail fait : « Mail envoyé », « Appel », … à une date.
-- p_fini : le reste à faire est terminé — il s'efface, avec son échéance.
create or replace function public.client_travail(
  p_file uuid, p_kind text, p_date date default null, p_texte text default null,
  p_job uuid default null, p_fini boolean default false
) returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_label text;
  v_date  date := coalesce(p_date, current_date);
  v_texte text := nullif(btrim(coalesce(p_texte, '')), '');
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
    -- Le geste le plus courant : tout ce qui était à faire est fait.
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
  if not exists (select 1 from public.client_files where id = p_file) then
    raise exception 'Dossier introuvable.';
  end if;

  insert into public.client_notes (file_id, job_id, body, automatique, author, author_name, work_kind, work_date)
  values (p_file, p_job,
          '✓ ' || v_label || ' le ' || to_char(v_date, 'DD/MM/YYYY') || coalesce(' — ' || v_texte, ''),
          false, auth.uid(), public._client_moi(), p_kind, v_date);

  if p_fini or p_kind = 'traite' then
    update public.client_files set todo = null, todo_due = null, todo_urgent = false where id = p_file;
  else
    update public.client_files set updated_at = now() where id = p_file;
  end if;
  return json_build_object('ok', true);
end;
$$;

-- La liste : le dernier travail fait de chaque dossier, pour la carte
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
             (select json_build_object('kind', n.work_kind, 'date', n.work_date,
                                       'body', n.body, 'author_name', n.author_name)
                from public.client_notes n where n.file_id = f.id and n.work_kind is not null
               order by n.work_date desc, n.created_at desc limit 1) as last_work
        from public.client_files f
       where public.is_client_member()
    ) d;
$$;

-- ---------------------------------------------------------------------
-- 4. LES DOCUMENTS D'UN DOSSIER CLIENT
-- ---------------------------------------------------------------------
-- Un devis complémentaire, un plan, une photo : rangés dans le dossier,
-- et joints au mail du client par un lien de téléchargement signé (un
-- lien « mailto: » ne peut pas porter de pièce jointe). Vendeurs compris.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('clients', 'clients', false, 26214400, array[
  'application/pdf',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "clients read" on storage.objects;
create policy "clients read" on storage.objects
  for select using (bucket_id = 'clients' and public.is_client_member());
drop policy if exists "clients insert" on storage.objects;
create policy "clients insert" on storage.objects
  for insert with check (bucket_id = 'clients' and public.is_client_member());
drop policy if exists "clients delete" on storage.objects;
create policy "clients delete" on storage.objects
  for delete using (bucket_id = 'clients' and public.is_manager());

create table if not exists public.client_documents (
  id           uuid primary key default gen_random_uuid(),
  file_id      uuid not null references public.client_files(id) on delete cascade,
  job_id       uuid references public.client_jobs(id) on delete set null,
  path         text not null unique,
  name         text not null check (btrim(name) <> ''),
  content_type text,
  size         bigint,
  created_by   uuid references auth.users,
  created_name text,
  created_at   timestamptz not null default now()
);
create index if not exists client_documents_file_idx on public.client_documents (file_id, created_at);

alter table public.client_documents enable row level security;
drop policy if exists client_documents_read on public.client_documents;
create policy client_documents_read on public.client_documents for select using (public.is_client_member());
drop policy if exists client_documents_insert on public.client_documents;
create policy client_documents_insert on public.client_documents for insert with check (public.is_client_member());
drop policy if exists client_documents_delete on public.client_documents;
create policy client_documents_delete on public.client_documents for delete using (public.is_manager());

-- L'auteur est celui de la session ; l'ajout s'écrit dans le fil.
create or replace function public.client_documents_avant() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.created_by := auth.uid();
  new.created_name := public._client_moi();
  new.created_at := now();
  return new;
end;
$$;
drop trigger if exists client_documents_avant on public.client_documents;
create trigger client_documents_avant before insert on public.client_documents
  for each row execute function public.client_documents_avant();

create or replace function public.client_documents_fil() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.client_notes (file_id, job_id, body, automatique, author, author_name)
  values (new.file_id, new.job_id, 'Document ajouté : ' || new.name, true, auth.uid(), public._client_moi());
  update public.client_files set updated_at = now() where id = new.file_id;
  return null;
end;
$$;
drop trigger if exists client_documents_fil on public.client_documents;
create trigger client_documents_fil after insert on public.client_documents
  for each row execute function public.client_documents_fil();

grant select, insert, delete on public.client_documents to authenticated;

revoke all on function public.mails_sans_facture() from public;
revoke all on function public.mail_sans_facture_ecarter(uuid) from public;
revoke all on function public.client_travail(uuid, text, date, text, uuid, boolean) from public;
grant execute on function public.mails_sans_facture() to authenticated;
grant execute on function public.mail_sans_facture_ecarter(uuid) to authenticated;
grant execute on function public.client_travail(uuid, text, date, text, uuid, boolean) to authenticated;
