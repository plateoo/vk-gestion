-- =====================================================================
-- VK Gestion — profils des deux utilisateurs
-- À rejouer après la création des comptes dans auth.users.
-- Il n'existe volontairement aucun trigger ni policy d'insertion sur
-- `profiles` : ajouter quelqu'un à l'application se fait ici, à la main.
-- =====================================================================

insert into public.profiles (id, full_name, role)
select u.id, 'Jordan', 'manager'
from auth.users u where u.email = 'jordan@vkgestion.local'
on conflict (id) do update set full_name = excluded.full_name, role = excluded.role;

insert into public.profiles (id, full_name, role)
select u.id, 'Marie', 'secretary'
from auth.users u where u.email = 'marie@vkgestion.local'
on conflict (id) do update set full_name = excluded.full_name, role = excluded.role;
