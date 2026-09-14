-- =====================================================================
-- VK Gestion — le pays du fournisseur
--
-- Les achats intracommunautaires se déclarent à part : autoliquidation,
-- grilles séparées, listing intracommunautaire. Le comptable a besoin de
-- les voir ensemble, pas dispersés parmi les factures belges.
--
-- POURQUOI PAS LE TAUX DE TVA
-- On serait tenté de prendre « 0 % » comme indice d'achat étranger. Ce
-- serait faux : CESI ASBL est établie à Woluwe et facture à 0 % — une
-- exonération belge, pas de l'intracommunautaire. Deux factures auraient
-- été classées à l'étranger, et la déclaration avec.
--
-- Seul le NUMÉRO DE TVA dit le pays. À défaut, on ne devine pas : le pays
-- reste vide et se renseigne à la main sur la fiche. Une case vide qu'on
-- voit vaut mieux qu'un pays inventé.
-- =====================================================================

alter table public.suppliers
  add column if not exists country char(2);

comment on column public.suppliers.country is
  'Code pays ISO à deux lettres, déduit du numéro de TVA ou saisi à la main. Null = à préciser.';

-- ---------------------------------------------------------------------
-- Déduire le pays d'un numéro de TVA
--
-- Deux formes acceptées :
--   • préfixe à deux lettres d'un État membre — DE123…, FR123…
--   • dix chiffres sans préfixe : c'est la forme belge courante, et
--     c'est ainsi que la plupart des factures belges l'écrivent.
-- Tout le reste renvoie null. On préfère ne rien dire à se tromper.
-- ---------------------------------------------------------------------
create or replace function public.pays_depuis_tva(p_tva text)
returns char(2) language sql immutable
set search_path = public, pg_temp as $$
  with nettoye as (select upper(regexp_replace(coalesce(p_tva, ''), '[^A-Za-z0-9]', '', 'g')) as v)
  select case
    when v = '' then null
    when substring(v from 1 for 2) in
         ('BE','DE','FR','NL','LU','IT','ES','PT','AT','DK','SE','FI','IE','PL',
          'CZ','SK','HU','RO','BG','HR','SI','EE','LV','LT','CY','MT','EL','GR')
      then substring(v from 1 for 2)::char(2)
    -- Numéro belge écrit sans préfixe : 9 ou 10 chiffres, rien d'autre.
    when v ~ '^[0-9]{9,10}$' then 'BE'::char(2)
    else null
  end
  from nettoye;
$$;

-- Reprise de l'existant
update public.suppliers
   set country = public.pays_depuis_tva(vat_number)
 where country is null and vat_number is not null;

-- ---------------------------------------------------------------------
-- Et pour la suite : le pays se remplit tout seul quand un numéro de TVA
-- arrive ou change, SANS jamais écraser une saisie manuelle.
-- ---------------------------------------------------------------------
create or replace function public.tg_pays_fournisseur()
returns trigger language plpgsql
set search_path = public, pg_temp as $$
begin
  if new.country is null
     or (tg_op = 'UPDATE' and new.country is not distinct from old.country
         and new.vat_number is distinct from old.vat_number) then
    new.country := coalesce(public.pays_depuis_tva(new.vat_number), new.country);
  end if;
  return new;
end;
$$;

drop trigger if exists suppliers_pays on public.suppliers;
create trigger suppliers_pays
  before insert or update of vat_number, country on public.suppliers
  for each row execute function public.tg_pays_fournisseur();

create index if not exists suppliers_country_idx on public.suppliers (country);
