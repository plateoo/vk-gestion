# VK Gestion — suivi des factures fournisseurs

Application web interne de **Vandenborre Kitchen**. Elle ne remplace ni **Smart** (logiciel du
magasin) ni **WinAuditor** (comptabilité) : c'est la **couche de contrôle** par-dessus, pour voir
en un coup d'œil ce qui est encodé, envoyé au comptable, entré en stock, et surtout **payé ou pas**.

Deux utilisateurs :

| Rôle | Personne | Droits |
|---|---|---|
| `manager` | Jordan | tout, y compris le statut/date de paiement et la suppression |
| `secretary` | Marie | encode et modifie les factures ; statut de paiement en lecture seule |

## Stack

- HTML + CSS + JavaScript vanilla (ES modules) — **aucun framework, aucune étape de build**
- Backend : **Supabase** (PostgreSQL + Auth + Row Level Security), client officiel chargé en CDN ESM
- Hébergement : GitHub Pages → <https://plateoo.github.io/vk-gestion/>

## Structure

```
index.html              application complète (SPA à onglets) + amorçage
guide.html              mode d'emploi imprimable (10 sections)
css/style.css           feuille de style unique (desktop + mobile + impression)
assets/logo-vbk.svg     logo Vanden Borre Kitchen (couleur)
assets/logo-vbk-blanc.svg  logo blanc pour le bandeau foncé
assets/favicon.svg      favicon carré généré à partir du logo
js/config.js            SUPABASE_URL + SUPABASE_ANON_KEY
js/supabase.js          initialisation du client
js/auth.js              connexion / déconnexion / session / rôle
js/suppliers.js         CRUD fournisseurs + fiche fournisseur
js/invoices.js          CRUD factures, filtres, tri, tableau, actions en lot
js/dashboard.js         KPI du mois, alertes, top fournisseurs
js/export.js            export CSV (Excel FR) + impression PDF
js/tour.js              visite guidée du premier lancement
js/ui.js                helpers DOM, formatage €/dates, toasts, modales, popovers
```

## Charte

Une seule source de vérité pour les couleurs : le bloc `:root` de `css/style.css`.
Aucune valeur hexadécimale n'apparaît ailleurs dans la feuille de style.

Le **rouge de marque** (`--vbk-red`, `#FF3640`, celui du logo) sert à l'identité et aux actions
primaires. Le **rouge d'alerte** (`--danger`, `#9B1C1C`) sert aux retards et litiges, toujours sur
fond pâle. Les deux ne se côtoient jamais : le bouton « + Nouvelle facture », placé au-dessus du
tableau qui peut contenir des lignes en retard, est en contour (`.btn-outline`) et non en aplat.

## Didacticiel

- **Visite guidée** en 6 étapes au premier login, différente selon le rôle
  (drapeau `vkg_tour_done_<userId>` en `localStorage`), relançable via le menu `?` du bandeau.
- **`guide.html`** : mode d'emploi complet, sommaire cliquable, imprimable.
- **Aides contextuelles** : pastilles `?` sur Smart, WinAuditor, entrée en stock, sortie et acompte,
  plus des aides grises sous les champs sensibles du formulaire.

## Configuration

`js/config.js` contient les deux constantes de connexion :

```js
export const SUPABASE_URL = 'https://xxxxx.supabase.co';
export const SUPABASE_ANON_KEY = '...';
```

La clé `anon` est **publique par design** : elle est visible dans le code source du site.
La sécurité repose sur les **Row Level Security policies** définies côté Supabase
(lecture/écriture réservées aux utilisateurs authentifiés, suppression réservée au `manager`).
La clé `service_role` ne doit **jamais** apparaître dans le front.

### Qui peut voir les données

Il n'existe **aucun trigger** de création automatique de profil, et **aucune policy
d'insertion** sur `profiles`. Un compte créé hors circuit se retrouve donc sans profil,
et toutes les policies de `suppliers` et `invoices` passent par `public.is_member()`,
qui exige un profil. Résultat : même si quelqu'un parvient à s'inscrire, il ne voit
strictement rien.

**Ajouter un utilisateur** demande donc deux gestes : créer le compte dans Supabase,
puis insérer son profil en SQL (voir `supabase/migrations/0002_profiles.sql`).
La désactivation des inscriptions dans le dashboard reste une seconde barrière utile,
mais ce n'est pas elle qui protège les données.

## Développement local

```bash
cd /Users/admin/vk-gestion
python3 -m http.server 8000
# puis http://localhost:8000
```

Ne jamais ouvrir `index.html` en `file://` : les imports ES modules et le CORS ne fonctionnent pas.

## Base de données

Trois tables dans le schéma `public` :

- **suppliers** — `name` (unique), `vat_number`, `contact_name`, `email`, `phone`,
  `payment_terms` (jours, sert à calculer l'échéance), `iban`, `notes`, `archived`
- **invoices** — `supplier_id`, `invoice_number` (unique par fournisseur), `invoice_date`,
  `due_date`, `encoded_at`, `amount_htva`, `vat_rate`, `amount_tvac` (colonne **calculée**),
  `in_smart`, `in_winauditor`, `stock_in`, `stock_out`, `payment_status`, `payment_date`,
  `payment_method`, `expense_type`, `notes`
- **profiles** — `full_name`, `role` (`manager` | `secretary`), créé automatiquement à
  l'inscription d'un utilisateur

`payment_status` ∈ `a_payer` · `paye` · `en_retard` · `litige` · `acompte`

## Export CSV

Compatible **Excel FR** : séparateur `;`, UTF-8 **avec BOM**, dates `JJ/MM/AAAA`,
montants à virgule décimale sans symbole €, booléens `Oui`/`Non`.
Nom de fichier : `VK_factures_2026-09.csv`.

Trois exports : mois affiché · sélection courante (filtres appliqués) · toutes périodes.
Un bouton **Imprimer / PDF** produit un récapitulatif papier pour le comptable.

## Déploiement

```bash
gh auth switch --user plateoo
git add -A && git commit -m "..." && git push
```

GitHub Pages sert la branche `main` à la racine ; le site est statique, aucune compilation.
