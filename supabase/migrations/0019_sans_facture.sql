-- =====================================================================
-- VK Gestion — distinguer « rien à lire » de « lecture ratée »
--
-- Quatre messages étaient rangés en « erreur » avec le motif « aucune
-- pièce jointe exploitable ». En les ouvrant, leurs seules pièces jointes
-- étaient des logos de signature : le bandeau Vanden Borre Kitchen en
-- 600x250, le logo « Electrolux Always Improve ». Rien n'avait échoué :
-- il n'y avait pas de facture.
--
-- Les compter comme des erreurs envoyait Jordan chercher une panne qui
-- n'existe pas, et masquait la vraie question — la facture était dans le
-- corps du message, ou n'a jamais été jointe au transfert. Ces messages
-- ont maintenant leur état à eux, et l'écran dit quoi en faire.
-- =====================================================================

-- 'quarantine' a été ajouté par la migration 0006 : la liste doit le
-- reprendre, sinon la contrainte rejette 32 messages en attente
-- d'autorisation.
alter table public.inbound_queue drop constraint if exists inbound_queue_status_check;
alter table public.inbound_queue
  add constraint inbound_queue_status_check
  check (status in ('pending', 'processing', 'done', 'error', 'ignored',
                    'quarantine', 'sans_facture'));

comment on column public.inbound_queue.status is
  'pending · processing · done · error (la lecture a échoué) · sans_facture (il n''y avait aucune facture à lire) · quarantine · ignored';

-- Requalification des quatre messages déjà en base.
update public.inbound_queue
   set status = 'sans_facture'
 where status = 'error' and error = 'aucune pièce jointe exploitable';

-- ---------------------------------------------------------------------
-- L'écran Administration doit compter les deux séparément : une panne
-- demande une intervention, un message sans facture demande d'aller
-- chercher le document ailleurs.
-- ---------------------------------------------------------------------
-- La fonction existante est reprise telle quelle — l'écran s'appuie sur
-- chacun de ses champs — et complétée de deux entrées seulement.
create or replace function public.system_status()
returns json language sql stable as $$
  select json_build_object(
    'quarantaine',      (select count(*) from public.inbound_queue where status = 'quarantine'),
    'en_attente',       (select count(*) from public.inbound_queue where status in ('pending','processing')),
    'en_erreur',        (select count(*) from public.inbound_queue where status = 'error'),
    'traites',          (select count(*) from public.inbound_queue where status = 'done'),
    'derniere_reception', (select max(created_at) from public.inbound_queue),
    'a_controler',      (select count(*) from public.invoices where review_status = 'a_controler'),
    'factures',         (select count(*) from public.invoices),
    'fournisseurs',     (select count(*) from public.suppliers),
    'fiches_a_valider', (select count(*) from public.suppliers where needs_review),
    'expediteurs_autorises', (select count(*) from public.allowed_senders),
    'stockage_octets',  (select coalesce(sum((metadata->>'size')::bigint), 0)
                           from storage.objects where bucket_id = 'factures'),
    'stockage_fichiers',(select count(*) from storage.objects where bucket_id = 'factures'),
    'erreurs_extraction', coalesce((
      select json_agg(e order by e.quand desc) from (
        select q.sender_email, q.subject, q.error, q.processed_at as quand, q.attempts
          from public.inbound_queue q
         where q.status = 'error'
         order by q.processed_at desc nulls last
         limit 10
      ) e), '[]'::json),
    -- NOUVEAU : les messages arrivés sans aucune facture à lire. Ce ne
    -- sont pas des pannes, et les compter avec les erreurs envoyait
    -- chercher un problème inexistant.
    'sans_facture',     (select count(*) from public.inbound_queue where status = 'sans_facture'),
    -- Sujet, expéditeur et pièces jointes réelles, pour que le gérant
    -- puisse retrouver le message dans Outlook et y voir ce qui manque.
    'messages_sans_facture', coalesce((
      select json_agg(m order by m.quand desc) from (
        select q.sender_email, q.subject, q.received_at as quand,
               coalesce((select string_agg(f->>'name', ', ')
                           from jsonb_array_elements(q.files) f), 'aucune pièce jointe') as pieces
          from public.inbound_queue q
         where q.status = 'sans_facture'
         order by q.received_at desc
         limit 20
      ) m), '[]'::json)
  );
$$;

grant execute on function public.system_status() to authenticated;
