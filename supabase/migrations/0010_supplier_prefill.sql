-- =====================================================================
-- VK Gestion — LOT 4
--   • références libres sur la facture (bon de commande, chantier, client)
--   • fiches fournisseur pré-remplies depuis la facture, à valider
--   • journal des changements
--   • détection d'un IBAN divergent, sans modification automatique
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. RÉFÉRENCES LIBRES
--    Colonne nommée external_refs et non « references » : ce dernier est
--    un mot réservé SQL qu'il faudrait échapper partout.
-- ---------------------------------------------------------------------
alter table public.invoices
  add column if not exists external_refs text[] not null default '{}';

create index if not exists invoices_refs_idx on public.invoices using gin (external_refs);

-- ---------------------------------------------------------------------
-- 2. FICHE FOURNISSEUR PRÉ-REMPLIE
-- ---------------------------------------------------------------------
alter table public.suppliers
  add column if not exists address text,
  -- ce qui a été LU sur la facture, conservé tel quel pour l'affichage
  -- côte à côte pendant la validation
  add column if not exists extracted jsonb,
  add column if not exists validated_at timestamptz,
  add column if not exists validated_by uuid references auth.users;

-- ---------------------------------------------------------------------
-- 3. JOURNAL DES CHANGEMENTS
--    Lecture réservée au gérant ; l'écriture est ouverte aux membres,
--    puisque c'est l'application qui journalise ses propres actions.
-- ---------------------------------------------------------------------
create table if not exists public.change_log (
  id uuid primary key default gen_random_uuid(),
  entity      text not null,          -- 'supplier' | 'invoice'
  entity_id   uuid,
  entity_label text,                  -- nom lisible, conservé même après suppression
  field       text not null,
  old_value   text,
  new_value   text,
  reason      text,
  author      uuid references auth.users,
  author_name text,
  created_at  timestamptz default now()
);

create index if not exists change_log_date_idx on public.change_log (created_at desc);
create index if not exists change_log_entity_idx on public.change_log (entity, entity_id);

alter table public.change_log enable row level security;

drop policy if exists "change_log read"   on public.change_log;
drop policy if exists "change_log insert" on public.change_log;
create policy "change_log read"   on public.change_log for select using (public.is_manager());
create policy "change_log insert" on public.change_log for insert with check (public.is_member());

-- ---------------------------------------------------------------------
-- 4. RAPPROCHEMENT ENRICHI
--    L'ordre des clés ne change pas : TVA, puis expéditeur, puis nom
--    normalisé exact. Rien d'approximatif. Les données lues en plus
--    (adresse, IBAN) ne servent qu'à PRÉ-REMPLIR une fiche nouvelle,
--    jamais à rapprocher ni à modifier une fiche existante.
-- ---------------------------------------------------------------------
-- L'ancienne signature à trois arguments doit disparaître : sinon les deux
-- coexistent en surcharge et un appel à trois paramètres continue d'exécuter
-- l'ancienne version, sans pré-remplissage ni détection d'IBAN.
drop function if exists public.match_or_create_supplier(text, text, text);

create or replace function public.match_or_create_supplier(
  p_name    text,
  p_vat     text default null,
  p_email   text default null,
  p_address text default null,
  p_iban    text default null
) returns json language plpgsql security definer as $$
declare
  v_id    uuid;
  v_how   text;
  v_vat   text := public.normalize_vat(p_vat);
  v_norm  text := public.normalize_supplier_name(p_name);
  v_email text := lower(nullif(btrim(coalesce(p_email, '')), ''));
  v_created boolean := false;
  v_iban_existant text;
  v_iban_lu text := nullif(upper(regexp_replace(coalesce(p_iban, ''), '[^A-Za-z0-9]', '', 'g')), '');
begin
  -- 1. numéro de TVA
  if v_vat is not null then
    select id into v_id from public.suppliers
     where merged_into is null and public.normalize_vat(vat_number) = v_vat
     order by created_at limit 1;
    if v_id is not null then v_how := 'numéro de TVA'; end if;
  end if;

  -- 2. expéditeur déjà associé
  if v_id is null and v_email is not null then
    select id into v_id from public.suppliers
     where merged_into is null
       and (v_email = any(known_emails) or lower(email) = v_email)
     order by created_at limit 1;
    if v_id is not null then v_how := 'adresse expéditeur'; end if;
  end if;

  -- 3. nom normalisé, égalité stricte
  if v_id is null and v_norm is not null then
    select id into v_id from public.suppliers
     where merged_into is null and normalized_name = v_norm
     order by created_at limit 1;
    if v_id is not null then v_how := 'nom normalisé'; end if;
  end if;

  -- 4. création, pré-remplie depuis la facture
  if v_id is null then
    if coalesce(btrim(p_name), '') = '' then
      return json_build_object('id', null, 'matched_by', null, 'created', false,
                               'reason', 'nom du fournisseur absent');
    end if;
    insert into public.suppliers (name, vat_number, email, address, iban,
                                  needs_review, known_emails, extracted)
    values (btrim(p_name),
            nullif(btrim(coalesce(p_vat, '')), ''),
            v_email,
            nullif(btrim(coalesce(p_address, '')), ''),
            nullif(btrim(coalesce(p_iban, '')), ''),
            true,
            case when v_email is null then '{}'::text[] else array[v_email] end,
            json_build_object('nom', p_name, 'tva', p_vat, 'adresse', p_address,
                              'iban', p_iban, 'email', v_email, 'lu_le', now())::jsonb)
    returning id into v_id;
    v_how := 'création automatique';
    v_created := true;
  else
    if v_email is not null then
      update public.suppliers
         set known_emails = array(select distinct e from unnest(coalesce(known_emails, '{}') || array[v_email]) e)
       where id = v_id and not (v_email = any(coalesce(known_emails, '{}')));
    end if;
    -- On NE touche PAS à l'IBAN d'une fiche existante : on signale.
    select nullif(upper(regexp_replace(coalesce(iban, ''), '[^A-Za-z0-9]', '', 'g')), '')
      into v_iban_existant from public.suppliers where id = v_id;
  end if;

  return json_build_object(
    'id', v_id,
    'matched_by', v_how,
    'created', v_created,
    'iban_lu', v_iban_lu,
    'iban_fiche', v_iban_existant,
    -- vrai seulement si les deux existent ET diffèrent
    'iban_divergent', (v_iban_lu is not null and v_iban_existant is not null
                       and v_iban_lu <> v_iban_existant)
  );
end;
$$;

revoke all on function public.match_or_create_supplier(text, text, text, text, text) from public;
grant execute on function public.match_or_create_supplier(text, text, text, text, text)
  to service_role, authenticated;

-- ---------------------------------------------------------------------
-- 5. VALIDATION D'UNE FICHE
--    Journalise les champs réellement modifiés par rapport à ce qui avait
--    été lu, puis lève le drapeau « à valider ».
-- ---------------------------------------------------------------------
create or replace function public.validate_supplier(p_id uuid, p_changes json)
returns json language plpgsql security definer as $$
declare
  v_before public.suppliers%rowtype;
  v_name text;
  k text;
  v_old text;
  v_new text;
begin
  if not public.is_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  select * into v_before from public.suppliers where id = p_id;
  if not found then raise exception 'Fiche fournisseur introuvable.'; end if;

  select full_name into v_name from public.profiles where id = auth.uid();

  update public.suppliers set
    name          = coalesce(p_changes->>'name', name),
    vat_number    = coalesce(p_changes->>'vat_number', vat_number),
    address       = coalesce(p_changes->>'address', address),
    iban          = coalesce(p_changes->>'iban', iban),
    contact_name  = coalesce(p_changes->>'contact_name', contact_name),
    email         = coalesce(p_changes->>'email', email),
    phone         = coalesce(p_changes->>'phone', phone),
    payment_terms = coalesce((p_changes->>'payment_terms')::int, payment_terms),
    notes         = coalesce(p_changes->>'notes', notes),
    needs_review  = false,
    validated_at  = now(),
    validated_by  = auth.uid()
  where id = p_id;

  -- journal, champ par champ
  foreach k in array array['name','vat_number','address','iban','contact_name','email','phone','payment_terms','notes'] loop
    v_new := p_changes->>k;
    if v_new is null then continue; end if;
    execute format('select ($1).%I::text', k) into v_old using v_before;
    if v_old is distinct from v_new then
      insert into public.change_log (entity, entity_id, entity_label, field, old_value, new_value, reason, author, author_name)
      values ('supplier', p_id, v_before.name, k, v_old, v_new, 'validation de fiche', auth.uid(), v_name);
    end if;
  end loop;

  insert into public.change_log (entity, entity_id, entity_label, field, old_value, new_value, reason, author, author_name)
  values ('supplier', p_id, v_before.name, 'needs_review', 'true', 'false', 'fiche validée', auth.uid(), v_name);

  return json_build_object('id', p_id, 'validated', true);
end;
$$;

grant execute on function public.validate_supplier(uuid, json) to authenticated;
