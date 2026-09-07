-- =====================================================================
-- VK Gestion — schéma initial
-- Trois tables (profiles, suppliers, invoices), triggers, et Row Level
-- Security active partout : la clé anon est publique, c'est la RLS qui
-- protège réellement les données.
-- =====================================================================

-- ============ PROFILS UTILISATEURS ============
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text not null,
  role text not null default 'secretary' check (role in ('manager','secretary')),
  created_at timestamptz default now()
);

-- ============ FOURNISSEURS ============
create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  vat_number text,
  contact_name text,
  email text,
  phone text,
  payment_terms int default 30,
  iban text,
  notes text,
  archived boolean default false,
  created_at timestamptz default now()
);

-- ============ FACTURES ============
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  invoice_number text not null,
  invoice_date date not null,
  due_date date,
  encoded_at date not null default current_date,
  amount_htva numeric(12,2) not null default 0,
  vat_rate numeric(4,2) not null default 0.21,
  amount_tvac numeric(12,2) generated always as (round(amount_htva * (1 + vat_rate), 2)) stored,
  in_smart boolean not null default false,
  in_winauditor boolean not null default false,
  stock_in date,
  stock_out date,
  payment_status text not null default 'a_payer'
    check (payment_status in ('a_payer','paye','en_retard','litige','acompte')),
  payment_date date,
  payment_method text,
  expense_type text,
  notes text,
  created_by uuid references auth.users,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (supplier_id, invoice_number)
);

create index invoices_date_idx on public.invoices (invoice_date desc);
create index invoices_supplier_idx on public.invoices (supplier_id);
create index invoices_status_idx on public.invoices (payment_status);

-- updated_at auto
create or replace function public.touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger invoices_touch before update on public.invoices
for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- PAS de trigger de création automatique de profil.
-- Un compte créé sans intervention du gérant ne doit obtenir AUCUN profil :
-- sans profil, aucune policy ci-dessous ne passe, donc aucune donnée visible.
-- Les profils de Jordan et Marie sont insérés à la main (voir 0002).
-- Aucune policy d'insertion sur `profiles` : impossible d'en créer via l'API.
-- ---------------------------------------------------------------------

-- ============ SÉCURITÉ (RLS) ============
alter table public.profiles enable row level security;
alter table public.suppliers enable row level security;
alter table public.invoices enable row level security;

-- L'utilisateur connecté a-t-il un profil ? C'est le vrai test d'appartenance :
-- « être authentifié » ne suffit pas, il faut avoir été enregistré par le gérant.
-- security definer : la fonction lit profiles sans repasser par ses propres policies.
create or replace function public.is_member() returns boolean as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid());
$$ language sql security definer stable;

create or replace function public.is_manager() returns boolean as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'manager');
$$ language sql security definer stable;

create policy "read own profile" on public.profiles
  for select using (auth.uid() = id or public.is_manager());

create policy "suppliers read"   on public.suppliers for select using (public.is_member());
create policy "suppliers write"  on public.suppliers for insert with check (public.is_member());
create policy "suppliers update" on public.suppliers for update using (public.is_member());
create policy "suppliers delete" on public.suppliers for delete using (public.is_manager());

create policy "invoices read"    on public.invoices for select using (public.is_member());
create policy "invoices insert"  on public.invoices for insert with check (public.is_member());
create policy "invoices update"  on public.invoices for update using (public.is_member());
create policy "invoices delete"  on public.invoices for delete using (public.is_manager());
