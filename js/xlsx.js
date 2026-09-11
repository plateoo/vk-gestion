// =====================================================================
// xlsx.js — écriture d'un classeur Excel standard, sans dépendance.
//
// Un .xlsx est une archive ZIP contenant du XML. On écrit le strict
// nécessaire pour qu'Excel, LibreOffice et Numbers ouvrent le fichier
// sans avertissement : types de cellules, formats de date et de montant,
// première ligne figée et filtre automatique.
//
// Pourquoi pas du CSV : le CSV n'a pas de types. Une date y redevient du
// texte, un montant change de sens selon la langue d'Excel, et un numéro
// de facture commençant par un zéro le perd. Le comptable reçoit ici de
// vraies dates et de vrais nombres.
// =====================================================================
import { buildZip } from './zip.js';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  // Excel refuse d'ouvrir un fichier contenant des caractères de contrôle
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** Date ISO -> numéro de série Excel (jours depuis le 30/12/1899) */
function serialDate(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

/** 0 -> A, 25 -> Z, 26 -> AA */
function colName(n) {
  let s = '';
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Styles : 0 normal · 1 en-tête · 2 date · 3 montant · 4 entier
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2">
<numFmt numFmtId="164" formatCode="dd/mm/yyyy"/>
<numFmt numFmtId="165" formatCode="#,##0.00"/>
</numFmts>
<fonts count="2">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1A1A1A"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function celluleXml(ref, valeur, type) {
  if (valeur === null || valeur === undefined || valeur === '') return `<c r="${ref}"/>`;
  if (type === 'date') {
    const n = serialDate(valeur);
    return n === null
      ? `<c r="${ref}" t="inlineStr"><is><t>${esc(valeur)}</t></is></c>`
      : `<c r="${ref}" s="2"><v>${n}</v></c>`;
  }
  if (type === 'number' || type === 'money') {
    const n = Number(valeur);
    if (!Number.isFinite(n)) return `<c r="${ref}" t="inlineStr"><is><t>${esc(valeur)}</t></is></c>`;
    return `<c r="${ref}" s="${type === 'money' ? 3 : 0}"><v>${n}</v></c>`;
  }
  // Par défaut du texte : un numéro de facture garde ses zéros de tête et
  // n'est jamais réinterprété en date par Excel.
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(valeur)}</t></is></c>`;
}

/**
 * Construit un classeur à une feuille.
 * @param {{key:string,label:string,type?:string,width?:number}[]} colonnes
 * @param {object[]} lignes
 * @param {{sheetName?: string, titre?: string}} opts
 * @returns {Blob}
 */
export function buildXlsx(colonnes, lignes, opts = {}) {
  const feuille = (opts.sheetName || 'Factures').slice(0, 31).replace(/[\\/?*[\]:]/g, '-');

  const cols = colonnes.map((c, idx) =>
    `<col min="${idx + 1}" max="${idx + 1}" width="${c.width || 14}" customWidth="1"/>`).join('');

  const entete = `<row r="1" customFormat="1" s="1">${colonnes
    .map((c, idx) => `<c r="${colName(idx)}1" s="1" t="inlineStr"><is><t>${esc(c.label)}</t></is></c>`)
    .join('')}</row>`;

  const corps = lignes.map((ligne, r) => {
    const num = r + 2;
    const cellules = colonnes
      .map((c, idx) => celluleXml(`${colName(idx)}${num}`, ligne[c.key], c.type))
      .join('');
    return `<row r="${num}">${cellules}</row>`;
  }).join('');

  const derniere = colName(colonnes.length - 1);
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${entete}${corps}</sheetData>
<autoFilter ref="A1:${derniere}${Math.max(1, lignes.length + 1)}"/>
</worksheet>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${esc(feuille)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const blob = buildZip([
    { name: '[Content_Types].xml', data: types },
    { name: '_rels/.rels', data: rels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'xl/worksheets/sheet1.xml', data: sheet }
  ]);

  return new Blob([blob], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
}
