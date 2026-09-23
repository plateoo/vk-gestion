-- =====================================================================
-- VK Gestion — quand, et par qui
--
-- Jordan : « je vois quand Marie encode sur le Smart et autre, mais je ne
-- vois pas la date de quand elle le traite ; cela me permet également de
-- contrôler ce qu'elle fait par jour sur la plateforme. »
--
-- L'application savait dire CE QUI est fait — encodé Smart, envoyé
-- WinAuditor, contrôlé — mais pas QUAND. Une case cochée ne porte aucune
-- date, si bien qu'une facture encodée en janvier et une encodée ce matin
-- se ressemblent exactement. Impossible, dans ces conditions, de voir ce
-- qu'une journée a produit.
--
-- On horodate donc les trois gestes qui font le travail, et on signe : la
-- date seule dirait « quelque chose a bougé », pas « qui l'a fait ».
--
-- Pour le passé, rien à reconstituer : ces dates n'existaient pas, et les
-- inventer serait pire que de les laisser vides. Le suivi commence
-- aujourd'hui, et il le dit.
-- =====================================================================

alter table public.invoices
  add column if not exists smart_at   timestamptz,
  add column if not exists smart_name text,
  add column if not exists win_at     timestamptz,
  add column if not exists win_name   text,
  add column if not exists paid_at    timestamptz,
  add column if not exists paid_name  text;

comment on column public.invoices.smart_at is
  'Quand la facture a été marquée encodée dans Smart. Distinct de '
  'invoice_date et de encoded_at : c''est la date du GESTE, pas du document.';

create index if not exists invoices_smart_at_idx on public.invoices (smart_at desc)
  where smart_at is not null;
create index if not exists invoices_win_at_idx on public.invoices (win_at desc)
  where win_at is not null;

-- ---------------------------------------------------------------------
-- Le déclencheur de signature s'étend aux trois gestes
--
-- Toujours un déclencheur plutôt qu'un appel depuis l'application : la
-- référence Smart se saisit dans le tableau, dans la modale et à l'écran
-- de contrôle. Trois chemins, et un quatrième un jour ; un horodatage
-- posé à la main en oublierait un.
-- ---------------------------------------------------------------------
create or replace function public.tg_invoice_signature()
returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_nom text;
begin
  select full_name into v_nom from public.profiles where id = auth.uid();

  if new.review_status = 'valide'
     and (tg_op = 'INSERT' or old.review_status is distinct from 'valide') then
    new.validated_at   := now();
    new.validated_by   := auth.uid();
    new.validated_name := v_nom;
  end if;

  -- Encodée dans Smart. On horodate la MISE de la case, pas chacune de
  -- ses modifications ultérieures : corriger une référence n'est pas
  -- encoder une seconde fois.
  if new.in_smart and (tg_op = 'INSERT' or not coalesce(old.in_smart, false)) then
    new.smart_at   := now();
    new.smart_name := v_nom;
  elsif not new.in_smart and tg_op = 'UPDATE' and coalesce(old.in_smart, false) then
    new.smart_at   := null;
    new.smart_name := null;
  end if;

  if new.in_winauditor and (tg_op = 'INSERT' or not coalesce(old.in_winauditor, false)) then
    new.win_at   := now();
    new.win_name := v_nom;
  elsif not new.in_winauditor and tg_op = 'UPDATE' and coalesce(old.in_winauditor, false) then
    new.win_at   := null;
    new.win_name := null;
  end if;

  -- Le paiement porte déjà SA date — celle du virement, saisie à la main.
  -- Celle-ci est autre chose : le moment où quelqu'un l'a enregistré dans
  -- l'application. Les deux sont utiles et ne se confondent pas.
  if new.payment_status = 'paye'
     and (tg_op = 'INSERT' or old.payment_status is distinct from 'paye') then
    new.paid_at   := now();
    new.paid_name := v_nom;
  elsif new.payment_status <> 'paye' and tg_op = 'UPDATE' and old.payment_status = 'paye' then
    new.paid_at   := null;
    new.paid_name := null;
  end if;

  if new.forced_reason is not null
     and (tg_op = 'INSERT' or old.forced_reason is distinct from new.forced_reason) then
    new.forced_at   := now();
    new.forced_by   := auth.uid();
    new.forced_name := v_nom;
  end if;

  if new.forced_reason is null and tg_op = 'UPDATE' and old.forced_reason is not null then
    new.forced_at := null; new.forced_by := null; new.forced_name := null;
  end if;

  return new;
end;
$$;

drop trigger if exists invoices_signature on public.invoices;
create trigger invoices_signature
  before insert or update on public.invoices
  for each row execute function public.tg_invoice_signature();

-- ---------------------------------------------------------------------
-- Ce qu'une journée a produit
--
-- Une ligne par jour et par personne, avec le compte de chaque geste. On
-- compte des GESTES, pas des factures : la même facture peut être
-- contrôlée un jour, encodée le lendemain et payée la semaine suivante.
-- Les additionner donnerait un chiffre qui ne veut rien dire.
--
-- Réservé au gérant : c'est un regard sur le travail de quelqu'un, et
-- cela ne se partage pas dans les deux sens.
-- ---------------------------------------------------------------------
create or replace function public.activite(p_from date default null, p_to date default null)
returns json language sql stable security definer
set search_path = public, pg_temp as $$
  with bornes as (
    select coalesce(p_from, current_date - 30) as d1,
           coalesce(p_to, current_date) as d2
  ),
  gestes as (
    select validated_at::date as jour, validated_name as qui, 'controle' as geste
      from public.invoices, bornes
     where validated_at is not null and validated_at::date between d1 and d2
    union all
    select smart_at::date, smart_name, 'smart'
      from public.invoices, bornes
     where smart_at is not null and smart_at::date between d1 and d2
    union all
    select win_at::date, win_name, 'winauditor'
      from public.invoices, bornes
     where win_at is not null and win_at::date between d1 and d2
    union all
    select paid_at::date, paid_name, 'paiement'
      from public.invoices, bornes
     where paid_at is not null and paid_at::date between d1 and d2
    union all
    select suivi_at::date, suivi_name, 'signalement'
      from public.invoices, bornes
     where suivi_at is not null and suivi_at::date between d1 and d2
    union all
    select forced_at::date, forced_name, 'forcage'
      from public.invoices, bornes
     where forced_at is not null and forced_at::date between d1 and d2
  )
  select coalesce(json_agg(j order by j.jour desc, j.qui), '[]'::json) from (
    select jour,
           coalesce(qui, '—') as qui,
           count(*) filter (where geste = 'controle')    as controles,
           count(*) filter (where geste = 'smart')       as smart,
           count(*) filter (where geste = 'winauditor')  as winauditor,
           count(*) filter (where geste = 'paiement')    as paiements,
           count(*) filter (where geste = 'signalement') as signalements,
           count(*) filter (where geste = 'forcage')     as forcages,
           count(*)                                      as total
      from gestes
     where public.is_manager()
     group by jour, coalesce(qui, '—')
  ) j;
$$;

revoke all on function public.activite(date, date) from public;
grant execute on function public.activite(date, date) to authenticated;

-- ---------------------------------------------------------------------
-- Ce qui reste sans date : l'honnêteté du compteur
--
-- Les gestes antérieurs à cette migration n'ont pas de date, et ne
-- peuvent pas en avoir. Le dire évite qu'on lise « zéro geste en août »
-- comme « personne n'a travaillé en août ».
-- ---------------------------------------------------------------------
create or replace function public.activite_depuis()
returns json language sql stable security definer
set search_path = public, pg_temp as $$
  select json_build_object(
    'sans_date_smart', (select count(*) from public.invoices where in_smart and smart_at is null),
    'sans_date_win',   (select count(*) from public.invoices where in_winauditor and win_at is null),
    'sans_date_controle', (select count(*) from public.invoices
                            where review_status = 'valide' and validated_at is null),
    'premier_geste',   (select min(x) from (
        select min(validated_at) as x from public.invoices
        union all select min(smart_at) from public.invoices
        union all select min(win_at) from public.invoices) t)
  ) where public.is_manager();
$$;

revoke all on function public.activite_depuis() from public;
grant execute on function public.activite_depuis() to authenticated;
