-- =====================================================================
-- VK Gestion — réunir deux fiches fournisseur, vraiment
--
-- Jordan : « je me retrouve à avoir deux Electrolux, j'ai cliqué sur
-- réunir, il me dit que c'est déjà fait, mais pourtant cela n'est pas le
-- cas. »
--
-- Il avait raison, et le défaut était réel.
--
-- La table des factures interdit deux fois le même numéro chez le même
-- fournisseur. Or UNE facture Electrolux — n° 2173034068, 829,07 €, du
-- 21/01/2026 — existait sur les DEUX fiches. En déplaçant les factures
-- d'un bloc, la base butait sur cette collision, annulait toute la
-- transaction, et renvoyait une erreur d'unicité que l'application
-- traduisait par « Cet enregistrement existe déjà ». D'où le message
-- incompréhensible : une seule facture en double empêchait le
-- rapprochement de vingt-six autres, sans que rien ne le dise.
--
-- La fusion procède donc autrement : elle regarde d'abord ce qui se
-- heurte, déplace tout le reste, et RAPPORTE précisément les numéros
-- fautifs. Une fiche dont il reste des factures n'est pas supprimée —
-- elle attend que l'humain tranche, ce qui est le seul choix honnête
-- quand deux factures portent le même numéro.
-- =====================================================================

create or replace function public.merge_suppliers(p_keep uuid, p_drop uuid)
returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_deplacees   int;
  v_collisions  text[];
  v_restantes   int;
  v_nom_keep    text;
  v_nom_drop    text;
  v_tva_keep    text;
  v_tva_drop    text;
begin
  if not public.is_manager() then
    raise exception 'Seul le gérant peut réunir des fiches fournisseur.' using errcode = '42501';
  end if;
  if p_keep = p_drop then
    raise exception 'Impossible de réunir une fiche avec elle-même.';
  end if;

  select name, vat_number into v_nom_keep, v_tva_keep from public.suppliers where id = p_keep;
  select name, vat_number into v_nom_drop, v_tva_drop from public.suppliers where id = p_drop;
  if v_nom_keep is null or v_nom_drop is null then
    raise exception 'Fiche fournisseur introuvable.';
  end if;

  -- Ce qui se heurte : un même numéro de facture présent des deux côtés.
  -- C'est un vrai doublon de facture, pas un incident technique, et
  -- personne d'autre que l'utilisateur ne peut décider laquelle garder.
  select array_agg(distinct d.invoice_number order by d.invoice_number)
    into v_collisions
    from public.invoices d
    join public.invoices k
      on k.supplier_id = p_keep and k.invoice_number = d.invoice_number
   where d.supplier_id = p_drop;

  -- Tout ce qui ne se heurte pas est rattaché. Une collision isolée ne
  -- doit pas retenir en otage les vingt-cinq autres factures.
  update public.invoices d
     set supplier_id = p_keep, updated_at = now()
   where d.supplier_id = p_drop
     and not exists (select 1 from public.invoices k
                      where k.supplier_id = p_keep
                        and k.invoice_number = d.invoice_number);
  get diagnostics v_deplacees = row_count;

  -- Les adresses connues suivent : la reconnaissance automatique doit
  -- continuer de fonctionner sur les e-mails de la fiche absorbée.
  update public.suppliers k
     set known_emails = (
           select array(select distinct e from unnest(
             coalesce(k.known_emails, '{}') ||
             coalesce((select d.known_emails from public.suppliers d where d.id = p_drop), '{}') ||
             coalesce((select array[d.email] from public.suppliers d where d.id = p_drop and d.email is not null), '{}')
           ) e where e is not null)),
         -- Ce que la fiche conservée ne portait pas, elle le reprend.
         -- Jamais l'inverse : on n'écrase pas une valeur vérifiée.
         vat_number = coalesce(k.vat_number, v_tva_drop),
         email      = coalesce(k.email, (select d.email from public.suppliers d where d.id = p_drop)),
         iban       = coalesce(k.iban, (select d.iban from public.suppliers d where d.id = p_drop)),
         phone      = coalesce(k.phone, (select d.phone from public.suppliers d where d.id = p_drop)),
         address    = coalesce(k.address, (select d.address from public.suppliers d where d.id = p_drop)),
         country    = coalesce(k.country, (select d.country from public.suppliers d where d.id = p_drop))
   where k.id = p_keep;

  select count(*) into v_restantes from public.invoices where supplier_id = p_drop;

  if v_restantes = 0 then
    delete from public.suppliers where id = p_drop;
  else
    -- La fiche survit parce qu'elle porte encore des factures. On la
    -- marque tout de même comme rattachée : elle sort des listes, et le
    -- lien avec la fiche conservée n'est pas perdu.
    update public.suppliers set merged_into = p_keep where id = p_drop;
  end if;

  return json_build_object(
    'moved_invoices', v_deplacees,
    'kept',           p_keep,
    'nom_conserve',   v_nom_keep,
    'nom_absorbe',    v_nom_drop,
    'supprimee',      v_restantes = 0,
    'restantes',      v_restantes,
    'collisions',     coalesce(v_collisions, '{}'),
    -- Deux numéros de TVA différents : ce sont peut-être deux sociétés
    -- distinctes. On ne refuse pas, mais on le dit.
    'tva_differentes', (v_tva_keep is not null and v_tva_drop is not null
                        and public.normalize_vat(v_tva_keep) is distinct from public.normalize_vat(v_tva_drop)),
    'tva_conserve',   v_tva_keep,
    'tva_absorbe',    v_tva_drop
  );
end;
$$;

revoke all on function public.merge_suppliers(uuid, uuid) from public;
grant execute on function public.merge_suppliers(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Ce qui empêcherait une fusion, AVANT de la lancer
--
-- Jordan : « je dois pouvoir sélectionner chaque fournisseur et pouvoir
-- l'ajouter à un autre fournisseur afin que cela se regroupe
-- directement. » Une fusion manuelle, entre deux fiches quelconques, doit
-- pouvoir s'annoncer avant d'agir : combien de factures bougent, lesquelles
-- se heurtent, et si les numéros de TVA diffèrent.
-- ---------------------------------------------------------------------
create or replace function public.merge_preview(p_keep uuid, p_drop uuid)
returns json language plpgsql stable security definer
set search_path = public, pg_temp as $$
declare
  v_tva_keep text;
  v_tva_drop text;
  v_nom_keep text;
  v_nom_drop text;
begin
  if not public.is_manager() then
    raise exception 'Seul le gérant peut réunir des fiches fournisseur.' using errcode = '42501';
  end if;
  if p_keep = p_drop then
    raise exception 'Impossible de réunir une fiche avec elle-même.';
  end if;

  select name, vat_number into v_nom_keep, v_tva_keep from public.suppliers where id = p_keep;
  select name, vat_number into v_nom_drop, v_tva_drop from public.suppliers where id = p_drop;
  if v_nom_keep is null or v_nom_drop is null then
    raise exception 'Fiche fournisseur introuvable.';
  end if;

  return json_build_object(
    'nom_conserve', v_nom_keep,
    'nom_absorbe',  v_nom_drop,
    'tva_conserve', v_tva_keep,
    'tva_absorbe',  v_tva_drop,
    'tva_differentes', (v_tva_keep is not null and v_tva_drop is not null
                        and public.normalize_vat(v_tva_keep) is distinct from public.normalize_vat(v_tva_drop)),
    'a_deplacer', (select count(*) from public.invoices d
                    where d.supplier_id = p_drop
                      and not exists (select 1 from public.invoices k
                                       where k.supplier_id = p_keep
                                         and k.invoice_number = d.invoice_number)),
    'collisions', coalesce((
      select json_agg(c order by c.invoice_number) from (
        select d.invoice_number, d.invoice_date, d.amount_tvac
          from public.invoices d
          join public.invoices k
            on k.supplier_id = p_keep and k.invoice_number = d.invoice_number
         where d.supplier_id = p_drop) c), '[]'::json)
  );
end;
$$;

revoke all on function public.merge_preview(uuid, uuid) from public;
grant execute on function public.merge_preview(uuid, uuid) to authenticated;
