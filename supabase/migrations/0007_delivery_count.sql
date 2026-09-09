-- =====================================================================
-- VK Gestion — traçabilité des livraisons répétées
--
-- Un message déjà reçu était écarté sans laisser aucune trace. On ne
-- pouvait donc pas distinguer « Power Automate a envoyé deux fois » de
-- « Power Automate n'a envoyé qu'une fois », ce qui est exactement la
-- question qu'on se pose quand un message manque à l'appel.
-- =====================================================================

alter table public.inbound_queue
  add column if not exists deliveries int not null default 1,
  add column if not exists last_delivery_at timestamptz;

comment on column public.inbound_queue.deliveries is
  'Nombre de fois où ce message a été posté par Power Automate (déduplication sur message_id)';
