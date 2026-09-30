-- =====================================================================
-- VK Gestion — un fournisseur qui encode autrement, et une note qui se voit
--
-- 1. Jordan : « chez Electrolux il y a des problèmes pour les encodages,
--    mais les montants sont quand même bons, c'est juste une façon
--    d'encoder différemment. Fais en sorte qu'on puisse valider quand
--    même, tant que nous on a validé. »
--
--    Vérifié sur les huit factures Electrolux en attente : cinq portent
--    l'alerte « montants incohérents ». Les commentaires d'extraction
--    disent pourquoi, et Jordan a raison : « la base taxable tient compte
--    de l'escompte pour paiement comptant de 1,5 % appliqué sur le prix
--    net ». C'est une pratique parfaitement légale en Belgique — la TVA se
--    calcule sur la base diminuée de l'escompte, alors que la somme due
--    reste le prix plein. Dès lors HTVA + TVA ≠ TVAC, et le contrôle crie
--    au loup sur une facture irréprochable.
--
--    Une alerte qui se déclenche sur du normal est pire qu'une absence
--    d'alerte : elle apprend à ne plus les lire. Le contrôle est donc
--    corrigé côté serveur, et l'on ajoute ici de quoi dire, fiche par
--    fiche, « celui-ci encode ses montants autrement » — pour les cas que
--    le raisonnement ne couvre pas.
--
-- 2. « Quand Marie met une note sur le dossier car elle l'a traité, on
--    doit avoir une petite attention comme quoi elle a bien traité le
--    dossier. Car actuellement on ne sait pas sur lequel elle a
--    travaillé. »
--
--    Le champ « remarques » existait, mais il ne se voyait qu'en ouvrant
--    la facture, et il ne portait ni nom ni date. Écrire quelque part que
--    personne ne regarde revient à ne rien écrire.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Un fournisseur qui encode ses montants autrement
-- ---------------------------------------------------------------------
alter table public.suppliers
  add column if not exists encodage_particulier boolean not null default false;

comment on column public.suppliers.encodage_particulier is
  'Ce fournisseur présente ses montants autrement — base taxable réduite '
  'par un escompte, arrondis propres, ventilation inhabituelle. L''écart '
  'entre HTVA + TVA et le total devient une information, non une alerte. '
  'Les montants restent affichés et exportés tels quels.';

-- ---------------------------------------------------------------------
-- 2. Une remarque signée et datée
--
-- Le champ notes existait ; ce qui manquait, c'est de savoir QUI a écrit
-- et QUAND. Sans cela, « voir avec Bob » ne dit pas si quelqu'un s'en est
-- occupé hier ou il y a trois mois.
-- ---------------------------------------------------------------------
alter table public.invoices
  add column if not exists notes_at   timestamptz,
  add column if not exists notes_name text;

create index if not exists invoices_notes_idx on public.invoices (notes_at desc)
  where notes is not null;

-- Le déclencheur de signature prend aussi la remarque en charge.
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

  if new.payment_status = 'paye'
     and (tg_op = 'INSERT' or old.payment_status is distinct from 'paye') then
    new.paid_at   := now();
    new.paid_name := v_nom;
  elsif new.payment_status <> 'paye' and tg_op = 'UPDATE' and old.payment_status = 'paye' then
    new.paid_at   := null;
    new.paid_name := null;
  end if;

  -- La remarque. On ne signe que lorsqu'elle CHANGE : rouvrir une facture
  -- et la réenregistrer sans toucher au texte ne doit pas faire croire
  -- que quelqu'un s'en est occupé aujourd'hui.
  if coalesce(btrim(coalesce(new.notes, '')), '') <> ''
     and (tg_op = 'INSERT' or coalesce(old.notes, '') is distinct from coalesce(new.notes, '')) then
    new.notes_at   := now();
    new.notes_name := v_nom;
  elsif coalesce(btrim(coalesce(new.notes, '')), '') = '' and tg_op = 'UPDATE' then
    new.notes_at   := null;
    new.notes_name := null;
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
-- 3. Les remarques comptent dans l'activité du jour
--
-- Écrire une remarque, c'est traiter un dossier. C'était précisément le
-- reproche de Jordan : « on ne sait pas sur lequel elle a travaillé ».
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
    select notes_at::date, notes_name, 'remarque'
      from public.invoices, bornes
     where notes_at is not null and notes_at::date between d1 and d2
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
           count(*) filter (where geste = 'remarque')    as remarques,
           count(*) filter (where geste = 'forcage')     as forcages,
           count(*)                                      as total
      from gestes
     where public.is_manager()
     group by jour, coalesce(qui, '—')
  ) j;
$$;

revoke all on function public.activite(date, date) from public;
grant execute on function public.activite(date, date) to authenticated;
