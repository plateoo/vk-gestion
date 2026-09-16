-- =====================================================================
-- VK Gestion — la mémoire du poste
--
-- Tout ce qu'une secrétaire finit par savoir sans que ce soit écrit nulle
-- part : quel fournisseur envoie ses factures d'une adresse bizarre, à
-- qui téléphoner chez Electrolux, où se range le courrier des primes, ce
-- qu'il faut faire quand une facture arrive en double.
--
-- Ce savoir part avec la personne. Un congé, un remplacement, et le
-- magasin réapprend tout. Cette table existe pour que cela n'arrive pas.
--
-- Volontairement simple : un titre, un texte, un thème. Pas de champs
-- obligatoires, pas de structure imposée. Une base de connaissance qui
-- demande de remplir un formulaire ne se remplit pas.
-- =====================================================================
create table if not exists public.memo (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (btrim(title) <> ''),
  body        text not null default '',
  -- Un thème pour retrouver, pas pour classer finement.
  theme       text not null default 'divers'
              check (theme in ('encodage', 'fournisseurs', 'boite_mail',
                               'comptabilite', 'clients', 'divers')),
  -- Une fiche qu'on veut voir en premier : consignes du quotidien.
  epingle     boolean not null default false,
  created_by   uuid references auth.users,
  updated_by   uuid references auth.users,
  updated_name text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists memo_theme_idx on public.memo (theme, title);
create index if not exists memo_epingle_idx on public.memo (updated_at desc) where epingle;

alter table public.memo enable row level security;

-- Les deux lisent et écrivent : c'est une mémoire commune. Le gérant seul
-- supprime — une fiche effacée emporte un savoir qu'on ne retrouvera pas.
drop policy if exists memo_read on public.memo;
create policy memo_read on public.memo for select using (public.is_member());
drop policy if exists memo_insert on public.memo;
create policy memo_insert on public.memo for insert with check (public.is_member());
drop policy if exists memo_update on public.memo;
create policy memo_update on public.memo for update using (public.is_member()) with check (public.is_member());
drop policy if exists memo_delete on public.memo;
create policy memo_delete on public.memo for delete using (public.is_manager());

-- ---------------------------------------------------------------------
-- Enregistrer une fiche. Même fonction pour créer et pour modifier : du
-- point de vue de l'utilisateur, c'est le même geste.
-- ---------------------------------------------------------------------
create or replace function public.memo_save(
  p_id uuid, p_title text, p_body text,
  p_theme text default 'divers', p_epingle boolean default false
) returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_id  uuid;
  v_moi text;
begin
  if not public.is_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  if coalesce(btrim(coalesce(p_title, '')), '') = '' then
    raise exception 'La fiche a besoin d''un titre.';
  end if;

  select full_name into v_moi from public.profiles where id = auth.uid();

  if p_id is null then
    insert into public.memo (title, body, theme, epingle, created_by, updated_by, updated_name)
    values (btrim(p_title), coalesce(p_body, ''), coalesce(p_theme, 'divers'),
            coalesce(p_epingle, false), auth.uid(), auth.uid(), v_moi)
    returning id into v_id;
  else
    update public.memo
       set title = btrim(p_title), body = coalesce(p_body, ''),
           theme = coalesce(p_theme, 'divers'), epingle = coalesce(p_epingle, false),
           updated_by = auth.uid(), updated_name = v_moi, updated_at = now()
     where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'Fiche introuvable.'; end if;
  end if;

  return json_build_object('id', v_id);
end;
$$;

/** Toutes les fiches, épinglées d'abord. Le volume restera petit. */
create or replace function public.memo_list()
returns json language sql stable security definer
set search_path = public, pg_temp as $$
  select coalesce(json_agg(m order by m.epingle desc, m.theme, m.title), '[]'::json)
    from (select id, title, body, theme, epingle, updated_name, updated_at
            from public.memo where public.is_member()) m;
$$;

revoke all on function public.memo_save(uuid, text, text, text, boolean) from public;
revoke all on function public.memo_list() from public;
grant execute on function public.memo_save(uuid, text, text, text, boolean) to authenticated;
grant execute on function public.memo_list() to authenticated;
