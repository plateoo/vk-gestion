// =====================================================================
// zip.js — écriture d'archives ZIP, sans dépendance.
//
// L'application n'a ni bundler ni bibliothèque : une archive se fabrique
// ici, à la main. Les fichiers sont stockés tels quels (méthode 0, pas de
// compression). Les PDF et les .xlsx sont déjà compressés, les recompresser
// ne gagnerait presque rien et coûterait un déflateur complet.
//
// Format : en-tête local par fichier, puis annuaire central, puis fin
// d'annuaire. Les noms sont écrits en UTF-8 (drapeau 0x0800), ce qui fait
// tenir les accents sous Windows comme sous macOS.
// =====================================================================

const TABLE_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = TABLE_CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Date et heure au format DOS, sur deux mots de 16 bits */
function dosDateTime(d = new Date()) {
  const heure = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { heure, date };
}

const encodeur = new TextEncoder();
export function texteEnOctets(s) { return encodeur.encode(s); }

/**
 * Fabrique l'archive.
 * @param {{name: string, data: Uint8Array|string}[]} fichiers
 * @returns {Blob}
 */
export function buildZip(fichiers) {
  const { heure, date } = dosDateTime();
  const entrees = [];
  const morceaux = [];
  let offset = 0;

  for (const f of fichiers) {
    const nom = encodeur.encode(f.name);
    const data = typeof f.data === 'string' ? encodeur.encode(f.data) : f.data;
    const crc = crc32(data);

    const entete = new DataView(new ArrayBuffer(30));
    entete.setUint32(0, 0x04034b50, true);   // signature
    entete.setUint16(4, 20, true);           // version minimale
    entete.setUint16(6, 0x0800, true);       // noms en UTF-8
    entete.setUint16(8, 0, true);            // méthode : stocké
    entete.setUint16(10, heure, true);
    entete.setUint16(12, date, true);
    entete.setUint32(14, crc, true);
    entete.setUint32(18, data.length, true); // taille compressée
    entete.setUint32(22, data.length, true); // taille réelle
    entete.setUint16(26, nom.length, true);
    entete.setUint16(28, 0, true);           // pas de champ « extra »

    morceaux.push(new Uint8Array(entete.buffer), nom, data);
    entrees.push({ nom, crc, taille: data.length, offset });
    offset += 30 + nom.length + data.length;
  }

  const debutAnnuaire = offset;
  for (const e of entrees) {
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);                // version d'écriture
    c.setUint16(6, 20, true);                // version minimale
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, heure, true);
    c.setUint16(14, date, true);
    c.setUint32(16, e.crc, true);
    c.setUint32(20, e.taille, true);
    c.setUint32(24, e.taille, true);
    c.setUint16(28, e.nom.length, true);
    c.setUint16(30, 0, true);                // extra
    c.setUint16(32, 0, true);                // commentaire
    c.setUint16(34, 0, true);                // disque
    c.setUint16(36, 0, true);                // attributs internes
    c.setUint32(38, 0, true);                // attributs externes
    c.setUint32(42, e.offset, true);
    morceaux.push(new Uint8Array(c.buffer), e.nom);
    offset += 46 + e.nom.length;
  }

  const fin = new DataView(new ArrayBuffer(22));
  fin.setUint32(0, 0x06054b50, true);
  fin.setUint16(4, 0, true);
  fin.setUint16(6, 0, true);
  fin.setUint16(8, entrees.length, true);
  fin.setUint16(10, entrees.length, true);
  fin.setUint32(12, offset - debutAnnuaire, true);
  fin.setUint32(16, debutAnnuaire, true);
  fin.setUint16(20, 0, true);
  morceaux.push(new Uint8Array(fin.buffer));

  return new Blob(morceaux, { type: 'application/zip' });
}

/** Nom de fichier acceptable partout : pas de séparateur, pas de caractère interdit */
export function nomSur(s, defaut = 'document') {
  const net = String(s || '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return net || defaut;
}
