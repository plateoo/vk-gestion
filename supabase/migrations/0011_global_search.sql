-- =====================================================================
-- VK Gestion — recherche globale
--
-- Interroge la base et non le cache du navigateur : une facture trouvée
-- l'est même si l'écran affiche un autre mois. security invoker, donc les
-- policies RLS s'appliquent à l'appelant.
-- =====================================================================
create or replace function public.global_search(p_q text, p_limit int default 12)
returns json language sql stable as $$
  with brut as (
    select btrim(coalesce(p_q, '')) as q,
           regexp_replace(replace(btrim(coalesce(p_q, '')), ',', '.'), '[^0-9.]', '', 'g') as nettoye,
           regexp_replace(btrim(coalesce(p_q, '')), '[^0-9]', '', 'g') as chiffres
  ),
  terme as (
    select q,
           chiffres,
           '%' || lower(public.vk_unaccent(q)) || '%' as motif,
           -- Une saisie sans lettre est traitée comme un montant. « 0456.789.123 »
           -- (numéro de TVA) contient deux points : le cast échouerait et ferait
           -- planter toute la recherche, d'où le contrôle de forme préalable.
           case when nettoye ~ '^[0-9]+(\.[0-9]+)?$' then nettoye::numeric else null end as montant,
           (q !~ '[A-Za-z]' and length(chiffres) >= 3) as cherche_montant
      from brut
  )
  select json_build_object(
    'factures', coalesce((
      select json_agg(f) from (
        select i.id, i.invoice_number, i.smart_ref, i.external_refs,
               i.invoice_date, i.amount_tvac, i.payment_status, i.review_status,
               s.name as supplier_name, s.id as supplier_id
          from public.invoices i
          join public.suppliers s on s.id = i.supplier_id, terme t
         where length(t.q) >= 2 and (
               lower(public.vk_unaccent(i.invoice_number)) like t.motif
            or lower(public.vk_unaccent(coalesce(i.smart_ref, ''))) like t.motif
            or lower(public.vk_unaccent(coalesce(array_to_string(i.external_refs, ' '), ''))) like t.motif
            or lower(public.vk_unaccent(coalesce(i.notes, ''))) like t.motif
            or lower(public.vk_unaccent(s.name)) like t.motif
            or lower(public.vk_unaccent(coalesce(s.vat_number, ''))) like t.motif
            -- Montant : correspondance exacte à un centime près, ou saisie
            -- partielle — taper « 3932 » doit trouver 3.932,50 €.
            or (t.montant is not null and (abs(i.amount_tvac - t.montant) < 0.01
                                        or abs(i.amount_htva - t.montant) < 0.01))
            or (t.cherche_montant and (i.amount_tvac::text like '%' || t.chiffres || '%'
                                    or i.amount_htva::text like '%' || t.chiffres || '%'))
         )
         order by i.invoice_date desc
         limit p_limit
      ) f), '[]'::json),
    'fournisseurs', coalesce((
      select json_agg(x) from (
        select s.id, s.name, s.vat_number, s.email, s.needs_review,
               (select count(*) from public.invoices i where i.supplier_id = s.id) as factures,
               (select coalesce(sum(amount_tvac), 0) from public.invoices i where i.supplier_id = s.id) as total,
               (select coalesce(sum(amount_tvac), 0) from public.invoices i
                 where i.supplier_id = s.id and i.payment_status <> 'paye') as reste_du
          from public.suppliers s, terme t
         where length(t.q) >= 2 and s.merged_into is null and (
               lower(public.vk_unaccent(s.name)) like t.motif
            or lower(public.vk_unaccent(coalesce(s.vat_number, ''))) like t.motif
            or public.normalize_vat(s.vat_number) like '%' || public.normalize_vat(t.q) || '%'
            or lower(coalesce(s.email, '')) like t.motif
         )
         order by s.name
         limit p_limit
      ) x), '[]'::json)
  );
$$;

grant execute on function public.global_search(text, int) to authenticated;
