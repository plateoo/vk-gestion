-- =====================================================================
-- VK Gestion — réception des factures par e-mail
-- Colonnes de provenance sur invoices, liste blanche d'expéditeurs,
-- journal des messages refusés, et bucket privé des fichiers d'origine.
-- =====================================================================

-- ============ PROVENANCE DES FACTURES ============
alter table public.invoices
  add column if not exists source text not null default 'manuel'
    check (source in ('manuel','email')),
  add column if not exists review_status text not null default 'valide'
    check (review_status in ('a_controler','valide')),
  add column if not exists file_path text,
  add column if not exists sender_email text,
  add column if not exists message_id text unique,
  add column if not exists extraction_notes text,
  -- nombre de relances d'extraction déjà consommées (plafond de 3 côté interface)
  add column if not exists extraction_attempts int not null default 0;

alter table public.suppliers
  add column if not exists needs_review boolean default false;

-- La file de contrôle est la vue la plus consultée : index partiel, très léger.
create index if not exists invoices_review_idx on public.invoices (review_status)
  where review_status = 'a_controler';

create index if not exists invoices_source_idx on public.invoices (source);

-- ============ LISTE BLANCHE D'EXPÉDITEURS ============
-- Un message venu d'ailleurs est journalisé mais ne crée aucune facture :
-- sans cela, la file de contrôle devient une boîte à spam.
create table if not exists public.allowed_senders (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  label text,
  created_at timestamptz default now(),
  created_by uuid references auth.users
);

-- ============ JOURNAL DES MESSAGES REFUSÉS ============
create table if not exists public.rejected_messages (
  id uuid primary key default gen_random_uuid(),
  sender_email text,
  subject text,
  message_id text,
  reason text not null,
  received_at timestamptz default now()
);

create index if not exists rejected_messages_date_idx
  on public.rejected_messages (received_at desc);

-- ============ SÉCURITÉ ============
alter table public.allowed_senders enable row level security;
alter table public.rejected_messages enable row level security;

-- Tout le monde dans l'app doit voir qui est autorisé ; seul le gérant modifie.
drop policy if exists "allowed_senders read"   on public.allowed_senders;
drop policy if exists "allowed_senders insert" on public.allowed_senders;
drop policy if exists "allowed_senders update" on public.allowed_senders;
drop policy if exists "allowed_senders delete" on public.allowed_senders;
create policy "allowed_senders read"   on public.allowed_senders for select using (public.is_member());
create policy "allowed_senders insert" on public.allowed_senders for insert with check (public.is_manager());
create policy "allowed_senders update" on public.allowed_senders for update using (public.is_manager());
create policy "allowed_senders delete" on public.allowed_senders for delete using (public.is_manager());

-- Le journal des refus ne regarde que le gérant. Les écritures viennent de la
-- fonction serveur, qui utilise la clé service_role et ne passe pas par RLS.
drop policy if exists "rejected read"   on public.rejected_messages;
drop policy if exists "rejected delete" on public.rejected_messages;
create policy "rejected read"   on public.rejected_messages for select using (public.is_manager());
create policy "rejected delete" on public.rejected_messages for delete using (public.is_manager());

-- ============ BUCKET PRIVÉ DES FICHIERS D'ORIGINE ============
insert into storage.buckets (id, name, public)
values ('factures', 'factures', false)
on conflict (id) do update set public = false;

-- Lecture réservée aux membres de l'application (profil existant).
-- Les écritures restent le fait de la fonction serveur en service_role.
drop policy if exists "factures read" on storage.objects;
create policy "factures read" on storage.objects
  for select using (bucket_id = 'factures' and public.is_member());
