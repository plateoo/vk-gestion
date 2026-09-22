-- =====================================================================
-- VK Gestion — le suivi d'une facture, et l'encodage de l'ancien franchisé
--
-- Deux demandes de Jordan, liées par la même idée : une facture porte des
-- choses qu'aucune case à cocher existante ne sait dire.
--
-- 1. « Marie doit pouvoir mettre un commentaire sur la facture. Exemple
--    problème. Exemple encodé. Exemple documents manquants. »
--
--    Le champ « remarques » existait déjà, mais il n'était accessible
--    qu'en ouvrant la pièce en plein écran, et rien ne disait qui avait
--    écrit quoi ni quand. Surtout, une remarque libre ne se voit pas dans
--    une liste de deux cents lignes : il faut un ÉTAT, court et coloré,
--    qu'on repère en balayant le tableau. L'état dit quoi ; la remarque
--    dit pourquoi.
--
-- 2. « On doit pouvoir appuyer sur le bouton traité par l'ancien
--    franchisé, car quand nous n'avons pas les références Smart, je ne
--    sais pas encore comment les récupérer, mais cela ne veut pas dire
--    qu'il n'a pas été traité. »
--
--    Jusqu'ici, « encodé dans Smart » se prouvait par une référence. Sans
--    référence, la facture restait éternellement en attente d'encodage et
--    faussait tous les compteurs. Or l'ancien franchisé a bel et bien
--    encodé : ce qui manque, c'est le numéro, pas le travail. On distingue
--    donc « encodé par nous, voici la référence » de « encodé avant la
--    reprise, référence introuvable ».
--
--    C'est volontairement irréversible à la légère : la marque est posée
--    et retirée explicitement, et elle se voit dans le tableau. Une
--    facture réputée encodée sans preuve doit rester visible comme telle.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. L'état de suivi
--
-- Cinq valeurs, pas davantage. Une liste qui s'allonge cesse d'être lue,
-- et deux états voisins finissent par être employés au hasard.
-- ---------------------------------------------------------------------
alter table public.invoices
  add column if not exists suivi       text,
  add column if not exists suivi_note  text,
  add column if not exists suivi_name  text,
  add column if not exists suivi_at    timestamptz;

alter table public.invoices
  drop constraint if exists invoices_suivi_check;
alter table public.invoices
  add constraint invoices_suivi_check
  check (suivi is null or suivi in
    ('probleme', 'documents_manquants', 'a_relancer', 'encode', 'a_voir'));

comment on column public.invoices.suivi is
  'État de suivi posé à la main : probleme, documents_manquants, a_relancer, '
  'encode, a_voir. Null = rien à signaler. L''état se repère dans la liste ; '
  'suivi_note dit pourquoi.';

create index if not exists invoices_suivi_idx on public.invoices (suivi)
  where suivi is not null;

-- ---------------------------------------------------------------------
-- 2. Encodé par l'ancien franchisé
--
-- Une colonne à part, et non un simple in_smart coché : il faut pouvoir
-- répondre plus tard à « lesquelles n'ont pas de référence ? ». Un
-- booléen noyé dans in_smart aurait effacé la question.
-- ---------------------------------------------------------------------
alter table public.invoices
  add column if not exists smart_ancien boolean not null default false;

comment on column public.invoices.smart_ancien is
  'Encodée dans Smart par l''ancien franchisé, référence introuvable. '
  'Compte comme encodée, mais reste repérable : la preuve manque.';

create index if not exists invoices_smart_ancien_idx on public.invoices (smart_ancien)
  where smart_ancien;

-- ---------------------------------------------------------------------
-- 3. Poser un état de suivi
--
-- Une seule fonction pour l'état et la remarque : à l'écran c'est un seul
-- geste, et les séparer exposerait à enregistrer l'un sans l'autre.
-- ---------------------------------------------------------------------
create or replace function public.invoice_suivi(
  p_id uuid, p_suivi text default null, p_note text default null
) returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_moi text;
begin
  if not public.is_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  if p_suivi is not null and p_suivi not in
     ('probleme', 'documents_manquants', 'a_relancer', 'encode', 'a_voir') then
    raise exception 'État de suivi inconnu : %', p_suivi;
  end if;

  select full_name into v_moi from public.profiles where id = auth.uid();

  update public.invoices
     set suivi = p_suivi,
         suivi_note = nullif(btrim(coalesce(p_note, '')), ''),
         -- Effacer l'état ET la remarque efface la signature : une facture
         -- redevenue normale ne doit pas garder le nom de qui l'avait
         -- signalée.
         suivi_name = case when p_suivi is null
                            and coalesce(btrim(coalesce(p_note, '')), '') = ''
                           then null else v_moi end,
         suivi_at   = case when p_suivi is null
                            and coalesce(btrim(coalesce(p_note, '')), '') = ''
                           then null else now() end,
         updated_at = now()
   where id = p_id;
  if not found then raise exception 'Facture introuvable.'; end if;

  return json_build_object('id', p_id, 'suivi', p_suivi);
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Marquer « encodée par l'ancien franchisé »
--
-- En lot : ces factures se reconnaissent par paquets — tout un
-- fournisseur, toute une période — et les traiter une par une serait la
-- garantie que personne ne le fasse.
-- ---------------------------------------------------------------------
create or replace function public.mark_smart_ancien(p_ids uuid[], p_undo boolean default false)
returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_n int;
begin
  if not public.is_member() then
    raise exception 'Non autorisé.' using errcode = '42501';
  end if;
  if p_ids is null or array_length(p_ids, 1) is null then
    raise exception 'Aucune facture sélectionnée.';
  end if;

  update public.invoices
     set smart_ancien = not coalesce(p_undo, false),
         -- La marque vaut encodage : sans cela, la facture resterait dans
         -- les compteurs « à encoder » et l'on n'aurait rien résolu.
         in_smart = case when coalesce(p_undo, false) then false else true end,
         updated_at = now()
   where id = any(p_ids)
     -- On ne touche pas à une facture qui porte une vraie référence : elle
     -- est encodée pour de bon, et la marque n'aurait aucun sens.
     and (coalesce(p_undo, false) or smart_ref is null);
  get diagnostics v_n = row_count;

  return json_build_object('touchees', v_n);
end;
$$;

revoke all on function public.invoice_suivi(uuid, text, text) from public;
revoke all on function public.mark_smart_ancien(uuid[], boolean) from public;
grant execute on function public.invoice_suivi(uuid, text, text) to authenticated;
grant execute on function public.mark_smart_ancien(uuid[], boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Les récapitulatifs distinguent les deux encodages
--
-- « 164 factures pas encore encodées dans Smart » est faux si quarante
-- l'ont été par l'ancien franchisé. Le chiffre qui compte devient « celles
-- qu'il nous reste à encoder ».
-- ---------------------------------------------------------------------
create or replace function public.period_summary(p_from date, p_to date)
returns json language sql stable as $$
  with r as (
    select * from public.invoices
     where invoice_date >= p_from and invoice_date <= p_to
       and review_status <> 'document'
  ),
  du as (select * from r where payment_status not in ('paye', 'avant_reprise'))
  select json_build_object(
    'count',       (select count(*) from r),
    'htva',        (select coalesce(sum(amount_htva), 0) from r),
    'tvac',        (select coalesce(sum(amount_tvac), 0) from r),
    'tva',         (select coalesce(sum(amount_tvac - amount_htva), 0) from r),
    'paid',        (select coalesce(sum(amount_tvac) filter (where payment_status = 'paye'), 0) from r),
    'due',         (select coalesce(sum(amount_tvac), 0) from du),
    'avant_reprise',(select count(*) from r where payment_status = 'avant_reprise'),
    'late_count',  (select count(*) from du where due_date is not null and due_date < current_date),
    'late_amount', (select coalesce(sum(amount_tvac), 0) from du where due_date is not null and due_date < current_date),
    'no_smart',    (select count(*) from r where not in_smart),
    'smart_ancien',(select count(*) from r where smart_ancien),
    'no_win',      (select count(*) from r where not in_winauditor),
    'no_stock',    (select count(*) from r where stock_in is null),
    'to_review',   (select count(*) from r where review_status = 'a_controler'),
    'forcees',     (select count(*) from r where forced_at is not null),
    'tva_manuelle',(select count(*) from r where vat_amount is not null),
    'suivi',       coalesce((select json_object_agg(x.suivi, x.n) from (
        select suivi, count(*) as n from r where suivi is not null group by suivi) x), '{}'::json),
    'documents',   (select count(*) from public.invoices
                     where review_status = 'document'
                       and invoice_date >= p_from and invoice_date <= p_to),
    'by_month', coalesce((select json_agg(m order by m.month) from (
        select to_char(invoice_date, 'YYYY-MM') as month,
               count(*)                          as count,
               sum(amount_tvac)                  as tvac,
               coalesce(sum(amount_tvac) filter (where payment_status = 'paye'), 0) as paid
          from r group by 1) m), '[]'::json),
    'by_vat', coalesce((select json_agg(v order by v.manuel, v.vat_rate desc) from (
        select case when vat_amount is not null then null else vat_rate end as vat_rate,
               (vat_amount is not null)            as manuel,
               count(*)                            as count,
               sum(amount_htva)                    as htva,
               sum(amount_tvac - amount_htva)      as tva,
               sum(amount_tvac)                    as tvac
          from r group by 1, 2) v), '[]'::json),
    'by_supplier', coalesce((select json_agg(s order by s.tvac desc) from (
        select r.supplier_id,
               sup.name,
               count(*)                        as count,
               sum(r.amount_htva)              as htva,
               sum(r.amount_tvac - r.amount_htva) as tva,
               sum(r.amount_tvac)              as tvac,
               coalesce(sum(r.amount_tvac) filter (where r.payment_status = 'paye'), 0)  as paid,
               coalesce(sum(r.amount_tvac) filter (where r.payment_status not in ('paye','avant_reprise')), 0) as due
          from r join public.suppliers sup on sup.id = r.supplier_id
         group by r.supplier_id, sup.name) s), '[]'::json)
  );
$$;
