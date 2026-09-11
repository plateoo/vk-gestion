// =====================================================================
// duplicates.js — repérage des factures enregistrées deux fois.
//
// La base interdit déjà deux fois le même numéro chez le même fournisseur,
// et deux fois la même pièce jointe dans le même message. Restent les cas
// qu'aucune contrainte ne peut attraper :
//
//   • la même facture arrive de deux expéditeurs — l'ancien franchisé la
//     retransmet, le fournisseur l'envoie aussi en direct ;
//   • elle se range sous deux fiches fournisseur du même groupe
//     (« Electrolux Belgium N.V. » et « Electrolux Belgium N.V. / SA ») ;
//   • le numéro est écrit différemment d'une source à l'autre
//     (« INV_52356760 » et « 52356760 »).
//
// Ce module ne supprime jamais rien : il propose, avec le motif écrit en
// clair, et c'est le gérant qui trancher. Deux factures peuvent légitimement
// partager un montant et une date — deux livraisons le même jour.
// =====================================================================

/** Numéro réduit à l'essentiel : majuscules, sans ponctuation ni espace */
export function normalizeNumber(n) {
  return String(n || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Noyau chiffré du numéro : la plus longue suite de chiffres, si elle est
 * assez longue pour identifier une facture. « INV_52356760 » et
 * « 52356760 » partagent 52356760 ; « FA-2026-1 » n'a pas de noyau, sa
 * suite la plus longue est trop courte pour distinguer quoi que ce soit.
 */
export function numberCore(n) {
  const suites = String(n || '').match(/\d+/g) || [];
  const plusLongue = suites.reduce((a, b) => (b.length > a.length ? b : a), '');
  return plusLongue.length >= 6 ? plusLongue.replace(/^0+/, '') || plusLongue : '';
}

/** Un numéro attribué faute de mieux ne prouve rien : il ne sert pas de clé. */
function sansNumero(n) {
  return !n || /^SANSNUMERO/.test(normalizeNumber(n));
}

const montant = (i) => Math.round((Number(i.amount_tvac) || 0) * 100);

const NIVEAUX = { certain: 3, probable: 2, verifier: 1 };

/**
 * Groupes de factures susceptibles d'être la même.
 * @param {object[]} invoices  factures normalisées (avec supplier_name)
 * @returns {{cle:string, niveau:string, motif:string, invoices:object[]}[]}
 */
export function findDuplicates(invoices) {
  const factures = (invoices || []).filter((i) => i.review_status !== 'document');
  const groupes = new Map();

  const ajouter = (cle, niveau, motif, lignes) => {
    if (lignes.length < 2) return;
    const ids = lignes.map((i) => i.id).sort().join('|');
    const existant = groupes.get(ids);
    // Un même groupe peut être trouvé par plusieurs chemins : on garde le
    // motif le plus fort, celui qui demande le moins d'interprétation.
    if (existant && NIVEAUX[existant.niveau] >= NIVEAUX[niveau]) return;
    groupes.set(ids, { cle, niveau, motif, invoices: lignes });
  };

  const parCle = (fn) => {
    const m = new Map();
    for (const i of factures) {
      const k = fn(i);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(i);
    }
    return m;
  };

  // 1. Même numéro chez le même fournisseur : la base l'interdit, donc cela
  //    ne peut venir que de deux fiches distinctes du même fournisseur.
  for (const [k, lignes] of parCle((i) =>
    sansNumero(i.invoice_number) ? '' : `${normalizeNumber(i.invoice_number)}·${(i.supplier_name || '').toLowerCase()}`)) {
    ajouter(k, 'certain', 'Même numéro de facture et même fournisseur.', lignes);
  }

  // 2. Même numéro et même montant, sous deux fiches différentes.
  for (const [k, lignes] of parCle((i) =>
    sansNumero(i.invoice_number) ? '' : `${normalizeNumber(i.invoice_number)}·${montant(i)}`)) {
    ajouter(k, 'certain',
      'Même numéro de facture et même montant, rangés sous deux fiches fournisseur.', lignes);
  }

  // 3. Même noyau chiffré et même montant : le numéro est écrit autrement
  //    d'une source à l'autre.
  for (const [k, lignes] of parCle((i) =>
    sansNumero(i.invoice_number) || !numberCore(i.invoice_number) ? '' : `${numberCore(i.invoice_number)}·${montant(i)}`)) {
    ajouter(k, 'probable',
      'Le numéro est écrit différemment d\'une source à l\'autre, mais le montant est identique.', lignes);
  }

  // 4. Même fournisseur, même date, même montant, numéros différents.
  //    Souvent deux livraisons le même jour : à regarder, pas à croire.
  for (const [k, lignes] of parCle((i) =>
    montant(i) > 0 && i.invoice_date ? `${i.supplier_id}·${i.invoice_date}·${montant(i)}` : '')) {
    ajouter(k, 'verifier',
      'Même fournisseur, même date et même montant. Les numéros diffèrent : il peut s\'agir de deux factures distinctes.', lignes);
  }

  // 5. Même fichier joint, sous deux lignes : le même document a été traité
  //    deux fois. Le nom seul ne suffit pas — « Electrolux-facture.pdf »
  //    sert à tous leurs envois — on exige donc aussi le même montant.
  for (const [k, lignes] of parCle((i) => {
    const nom = String(i.file_path || '').replace(/^.*\/[0-9a-f-]{36}-/i, '');
    return nom ? `${nom.toLowerCase()}·${montant(i)}` : '';
  })) {
    ajouter(k, 'probable', 'Le même document a été enregistré deux fois.', lignes);
  }

  return [...groupes.values()].sort((a, b) => {
    const n = NIVEAUX[b.niveau] - NIVEAUX[a.niveau];
    if (n) return n;
    return String(b.invoices[0].invoice_date || '').localeCompare(String(a.invoices[0].invoice_date || ''));
  });
}

/** Nombre de factures concernées, pas de groupes : c'est ce qui parle au gérant. */
export function duplicateCount(groupes) {
  const ids = new Set();
  for (const g of groupes) for (const i of g.invoices) ids.add(i.id);
  return ids.size;
}

export const NIVEAU_LABELS = {
  certain: 'Doublon',
  probable: 'Probable',
  verifier: 'À vérifier'
};
