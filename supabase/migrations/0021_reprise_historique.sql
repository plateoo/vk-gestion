-- =====================================================================
-- VK Gestion — reprise d'historique
--
-- L'ancien franchisé a retransmis sa boîte entière. Sur les 188 factures
-- à contrôler, 80 ont plus de trois mois : elles ont été réglées par la
-- franchise avant que le magasin ne reprenne, et ne sont dues par
-- personne ici. L'application les comptait pourtant comme impayées et
-- annonçait 73 725 € de retard.
--
-- Un tableau de bord qui crie au loup dès le premier jour cesse d'être
-- regardé. Ces factures reçoivent donc un état qui dit ce qu'elles sont :
-- antérieures à la reprise. Elles restent consultables, cherchables et
-- exportables — elles sortent seulement de ce qui reste à payer.
--
-- C'est un état de PAIEMENT et non un champ à part : tous les filtres,
-- exports et totaux existants le comprennent sans être touchés.
-- =====================================================================

alter table public.invoices drop constraint if exists invoices_payment_status_check;
alter table public.invoices
  add constraint invoices_payment_status_check
  check (payment_status in ('a_payer', 'paye', 'en_retard', 'litige', 'acompte', 'avant_reprise'));

comment on column public.invoices.payment_status is
  'a_payer · paye · en_retard · litige · acompte · avant_reprise (réglée avant la reprise du magasin : ne compte dans aucun total dû)';

-- ---------------------------------------------------------------------
-- Marquer un lot, et pouvoir revenir en arrière
--
-- Le retour en arrière compte autant que l'aller : si une seule de ces
-- factures se révèle réellement impayée, il faut pouvoir la remettre dans
-- le circuit sans manipulation obscure.
-- ---------------------------------------------------------------------
create or replace function public.mark_before_takeover(p_ids uuid[], p_undo boolean default false)
returns json language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_n   int;
  v_nom text;
begin
  if not public.is_manager() then
    raise exception 'Seul le gérant peut déclarer une reprise d''historique.' using errcode = '42501';
  end if;
  if p_ids is null or array_length(p_ids, 1) is null then
    raise exception 'Aucune facture indiquée.';
  end if;

  select full_name into v_nom from public.profiles where id = auth.uid();

  if p_undo then
    update public.invoices
       set payment_status = 'a_payer', updated_at = now()
     where id = any(p_ids) and payment_status = 'avant_reprise';
  else
    -- On ne touche jamais à une facture déjà payée ou en litige : son état
    -- porte une information que la reprise n'annule pas.
    update public.invoices
       set payment_status = 'avant_reprise', updated_at = now()
     where id = any(p_ids) and payment_status in ('a_payer', 'en_retard');
  end if;
  get diagnostics v_n = row_count;

  insert into public.change_log (entity, entity_id, entity_label, field, old_value, new_value,
                                 reason, author, author_name)
  select 'invoice', i.id, coalesce(s.name, '?') || ' ' || i.invoice_number, 'payment_status',
         case when p_undo then 'avant_reprise' else 'à payer' end,
         case when p_undo then 'à payer' else 'avant_reprise' end,
         case when p_undo then 'remise dans le circuit de paiement'
              else 'reprise d''historique : réglée avant la reprise du magasin' end,
         auth.uid(), v_nom
    from public.invoices i left join public.suppliers s on s.id = i.supplier_id
   where i.id = any(p_ids)
     and i.payment_status = case when p_undo then 'a_payer' else 'avant_reprise' end;

  return json_build_object('traitees', v_n, 'annulation', p_undo);
end;
$$;

revoke all on function public.mark_before_takeover(uuid[], boolean) from public;
grant execute on function public.mark_before_takeover(uuid[], boolean) to authenticated;

-- ---------------------------------------------------------------------
-- Les agrégats doivent suivre : une facture antérieure à la reprise
-- n'est ni due, ni en retard.
-- ---------------------------------------------------------------------
create or replace function public.period_summary(p_from date, p_to date)
returns json language sql stable as $$
  with r as (
    select * from public.invoices
     where invoice_date >= p_from and invoice_date <= p_to
       and review_status <> 'document'
  ),
  -- « dû » exclut ce qui est payé ET ce qui précède la reprise
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
    'no_win',      (select count(*) from r where not in_winauditor),
    'no_stock',    (select count(*) from r where stock_in is null),
    'to_review',   (select count(*) from r where review_status = 'a_controler'),
    'documents',   (select count(*) from public.invoices
                     where review_status = 'document'
                       and invoice_date >= p_from and invoice_date <= p_to),
    'by_month', coalesce((select json_agg(m order by m.month) from (
        select to_char(invoice_date, 'YYYY-MM') as month,
               count(*)                          as count,
               sum(amount_tvac)                  as tvac,
               coalesce(sum(amount_tvac) filter (where payment_status = 'paye'), 0) as paid
          from r group by 1) m), '[]'::json),
    'by_vat', coalesce((select json_agg(v order by v.vat_rate desc) from (
        select vat_rate,
               count(*)                            as count,
               sum(amount_htva)                    as htva,
               sum(amount_tvac - amount_htva)      as tva,
               sum(amount_tvac)                    as tvac
          from r group by 1) v), '[]'::json),
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
