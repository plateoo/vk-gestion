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
/**
 * Ces numéros se suivent-ils ?
 *
 * Deux factures du même jour numérotées à la file sont deux documents
 * distincts, pas un doublon. On compare les noyaux chiffrés : « FT202601265 »
 * et « FT202601266 » se suivent, « INV_5235 » et « 8841 » n'ont rien à voir.
 *
 * On exige que TOUS les numéros du groupe forment une suite : deux d'entre
 * eux consécutifs et un troisième identique resterait suspect.
 */
export function numerosQuiSeSuivent(lignes) {
  if (!lignes || lignes.length < 2) return false;
  const noyaux = lignes.map((i) => numberCore(i.invoice_number));
  if (noyaux.some((n) => !n)) return false;
  // Même longueur : sinon on compare des numérotations différentes, et
  // « 999 » suivi de « 1000 » n'est pas un cas qui se présente ici.
  if (new Set(noyaux.map((n) => n.length)).size !== 1) return false;
  const nombres = noyaux.map(Number).filter(Number.isSafeInteger).sort((x, y) => x - y);
  if (nombres.length !== lignes.length) return false;
  if (new Set(nombres).size !== nombres.length) return false;   // un doublon exact reste un doublon
  return nombres.every((n, k) => k === 0 || n === nombres[k - 1] + 1);
}

export function findDuplicates(invoices) {
  const factures = (invoices || []).filter((i) => i.review_status !== 'document');
  const groupes = new Map();

  const ajouter = (cle, niveau, motif, lignes) => {
    if (lignes.length < 2) return;
    // Des numéros qui se suivent ne peuvent PAS désigner la même facture,
    // quelle que soit la règle qui a rapproché ces lignes. Le garde-fou
    // est donc ici, et pas dans une règle en particulier : Electrolux
    // nomme toutes ses pièces jointes « Electrolux-facture.pdf », si bien
    // que la règle du fichier tombait dans le même piège que celle du
    // montant. Les règles fondées sur le numéro lui-même ne sont jamais
    // concernées — deux numéros identiques ne se suivent pas.
    if (numerosQuiSeSuivent(lignes)) return;
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
  //    Règle la plus fragile des cinq : un fournisseur qui facture à la
  //    livraison émet couramment deux factures le même jour pour le même
  //    montant. Le garde-fou des numéros consécutifs, posé dans ajouter(),
  //    écarte les cas que Jordan a signalés.
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

// =====================================================================
// Fiches fournisseur en double
//
// Chaque facture dont le fournisseur n'est pas reconnu crée une fiche.
// Avec le temps, un même fournisseur s'éparpille : Electrolux existait en
// quatre fiches — « Electrolux Belgium N.V. / SA », « Electrolux Belgium
// N.V. », « Electrolux Group », « Electrolux » — soit 26 factures
// réparties sur quatre totaux, tous faux.
// =====================================================================

/** Formes juridiques : elles ne distinguent pas deux sociétés */
const FORMES = /\b(nv|sa|bv|sprl|srl|bvba|gmbh|co|kg|ag|lda|ltda|asbl|vzw|ltd|plc|se|snc|scrl|scs|sas|sarl|spa|srls|oy|ab|as)\b/g;

/** « Belgrani, Lda. » et « belgrani » donnent tous deux « belgrani ». */
export function normalizeSupplier(nom) {
  return String(nom || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // accents
    .toLowerCase()
    // Les points disparaissent SANS laisser d'espace : « n.v. » doit
    // devenir « nv » pour être reconnu comme forme juridique. Le découper
    // en « n v » le rendrait invisible, et « Electrolux Belgium N.V. »
    // resterait distinct d'« Electrolux Belgium ».
    .replace(/\./g, '')
    .replace(/[,;/\\|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(FORMES, ' ')
    .replace(/[^a-z0-9]/g, '');
}

/** Numéro de TVA réduit à ses caractères significatifs */
function normalizeVat(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Groupes de fiches fournisseur susceptibles d'être la même société.
 * @param {object[]} suppliers  fiches, avec id et name
 * @param {object[]} invoices   factures, pour compter ce que chaque fiche porte
 */
export function findSupplierDuplicates(suppliers, invoices = []) {
  const compte = new Map();
  for (const i of invoices) {
    compte.set(i.supplier_id, (compte.get(i.supplier_id) || 0) + 1);
  }
  const fiches = (suppliers || [])
    .filter((s) => !s.archived)
    .map((s) => ({ ...s, factures: compte.get(s.id) || 0, cle: normalizeSupplier(s.name) }))
    .filter((s) => s.cle.length >= 3);

  // Les rapprochements se cumulent : « Electrolux Belgium N.V. » et
  // « Electrolux Belgium N.V. / SA » portent le même nom, et « Electrolux »
  // est le début des deux. Trois fiches, UNE société — donc un seul groupe,
  // pas deux qui se chevauchent. On relie, puis on prend les composantes.
  const liens = [];
  const ajouter = (niveau, motif, membres) => {
    if (membres.length < 2) return;
    for (let i = 1; i < membres.length; i++) {
      liens.push({ a: membres[0].id, b: membres[i].id, niveau, motif });
    }
  };

  // 1. Même numéro de TVA : c'est la même société, sans discussion possible.
  const parTva = new Map();
  for (const s of fiches) {
    const v = normalizeVat(s.vat_number);
    if (v.length < 8) continue;
    if (!parTva.has(v)) parTva.set(v, []);
    parTva.get(v).push(s);
  }
  for (const [, membres] of parTva) {
    ajouter('certain', 'Même numéro de TVA : c\'est la même société.', membres);
  }

  // 2. Même nom, une fois retirées ponctuation et forme juridique.
  const parNom = new Map();
  for (const s of fiches) {
    if (!parNom.has(s.cle)) parNom.set(s.cle, []);
    parNom.get(s.cle).push(s);
  }
  for (const [, membres] of parNom) {
    ajouter('certain', 'Même nom, à la forme juridique et à la ponctuation près.', membres);
  }

  // 3. Un nom est le début de l'autre : « Electrolux » et « Electrolux
  //    Belgium ». Très probable, mais deux sociétés d'un même groupe
  //    peuvent être distinctes — d'où un niveau en dessous.
  const restantes = fiches.slice().sort((a, b) => a.cle.length - b.cle.length);
  for (let i = 0; i < restantes.length; i++) {
    const proches = [restantes[i]];
    for (let j = i + 1; j < restantes.length; j++) {
      if (restantes[j].cle.startsWith(restantes[i].cle) && restantes[i].cle.length >= 6) {
        proches.push(restantes[j]);
      }
    }
    ajouter('probable', 'Un nom est le début de l\'autre : probablement la même société.', proches);
  }

  // Composantes connexes, par union-find : chaque société ne ressort
  // qu'une fois, avec toutes ses fiches.
  const parent = new Map(fiches.map((s) => [s.id, s.id]));
  const racine = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  const unir = (a, b) => {
    const ra = racine(a); const rb = racine(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const l of liens) unir(l.a, l.b);

  // Le motif retenu est celui du lien le plus sûr de la composante : c'est
  // lui qui justifie le rapprochement. Le regroupement peut être généreux
  // sans danger — chaque fusion se confirme fiche par fiche, en nommant
  // précisément ce qui part et ce qui reste.
  const parRacine = new Map();
  for (const s of fiches) {
    const r = racine(s.id);
    if (!parRacine.has(r)) parRacine.set(r, { membres: [], niveau: null, motif: '' });
    parRacine.get(r).membres.push(s);
  }
  for (const l of liens) {
    const g = parRacine.get(racine(l.a));
    if (!g) continue;
    if (!g.niveau || NIVEAUX[l.niveau] > NIVEAUX[g.niveau]) { g.niveau = l.niveau; g.motif = l.motif; }
  }

  return [...parRacine.values()]
    .filter((g) => g.membres.length > 1)
    .map((g) => ({
      niveau: g.niveau || 'probable',
      motif: g.motif,
      // La fiche à garder : celle qui porte le plus de factures. À égalité,
      // le nom le plus complet — il contient en général la forme juridique.
      suppliers: g.membres.slice().sort((a, b) =>
        (b.factures - a.factures) || (String(b.name).length - String(a.name).length))
    }))
    .sort((a, b) => {
      const n = NIVEAUX[b.niveau] - NIVEAUX[a.niveau];
      if (n) return n;
      return b.suppliers.length - a.suppliers.length;
    });
}
