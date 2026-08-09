// ============================================================================
// import_ca_schools.js -- ONE-SHOT import of the legacy CA-schools DB into the
// global leedz DB, THROUGH the running PRECRIME server's `pipeline save` action
// (never raw INSERTs -- every gate applies: company dedup, blacklist, banned
// terms, email validation).
//
//   node scripts/import_ca_schools.js --dry     preview only, no writes
//   node scripts/import_ca_schools.js           live import (server must be up)
//
// Rules (Scott, 2026-08-09):
// - ONE best contact per school, ranked by TITLE USEFULNESS FOR EVENT OUTREACH
//   (activities/events/community people beat heads-of-school; records
//   custodians last) and email quality (personal beats office@/records@).
//   All other contacts are preserved in clientNotes.
// - No valid email = not a client = not imported.
// - Religious schools are MARKED (segment school:jewish|catholic|christian|
//   muslim + a [PERMANENT] dossier line) so outreach targets THEIR calendar
//   (Purim carnival, fall festival, Eid) and NEVER secular Halloween.
// ============================================================================
'use strict';

const path = require('path');
const LEGACY = 'file:C:/Users/Scott/Desktop/WKG/PRECRIME/TMP/ca_schools_2.sqlite';
const SERVER = 'http://127.0.0.1:5179/mcp';
const DRY = process.argv.includes('--dry');

const { PrismaClient } = require(path.resolve(__dirname, '..', 'server', 'node_modules', '@prisma', 'client'));

// ---- contact ranking: lower score = better outreach contact ----------------
const TITLE_RANKS = [
    [/activit|event|student life|community|development|advancement|pta|auxiliar|room parent|volunteer/i, 0],
    [/admission|marketing|communication/i, 1],
    [/head|principal|director|dean|president|rabbi|administrator|superintendent/i, 2],
    [/office|assistant|secretary|registrar|coordinator/i, 3],
    [/custodian|records/i, 5]
];
const GENERIC_EMAIL = /^(info|office|records|admin|contact|hello|mail|school|frontdesk|admissions)@/i;

function titleOf(c) { return String(c.clientNotes || '').split('\n')[0].trim() || 'contact'; }
function contactScore(c) {
    const t = titleOf(c);
    let rank = 4; // unknown titles sit between office staff and records
    for (const [re, r] of TITLE_RANKS) { if (re.test(t)) { rank = r; break; } }
    return rank * 10 + (GENERIC_EMAIL.test(String(c.email || '')) ? 5 : 0);
}

// ---- denomination detection (best-effort keywords; unknown = secular) ------
// Two regex tiers per denomination: `anywhere` = unambiguous words, safe to
// match in notes/dossier text too; `nameOnly` = ambiguous words ("St." is also
// a STREET abbreviation in every address line) that may only match the school's
// own name/company/website. Muslim/Jewish are checked before Catholic/Christian
// (their keywords are the most specific).
const DENOMS = [
    ['muslim', 'e.g. Eid al-Fitr and Eid al-Adha celebrations',
        /islamic|muslim|madrasa|al-huda|new horizon school|crescent academy/i,
        /\bnoor\b|\biqra\b/i],
    ['jewish', 'e.g. Purim carnival, Chanukah celebration, Lag BaOmer festival',
        /yeshiva|hebrew|torah|chabad|jewish|sephardic|\bbais\b|\bbeis\b|\bbnos\b|\bbnei\b|schechter|maimonides|akiba|shalhevet|yavneh|milken|kadima|emek/i,
        /sinai|hillel/i],
    ['catholic', 'e.g. fall festival, feast-day carnival, Advent/Christmas fair',
        /catholic|our lady|sacred heart|notre dame|loyola|salesian|marymount|mater dei|immaculate|xavier|aquinas|jesuit|corpus christi|precious blood|archdiocese/i,
        /\bst\.?\s|saint|holy |bishop|parish|carmel|dominican|mercy/i],
    ['christian', 'e.g. harvest festival, Christmas fair, VBS carnival',
        /lutheran|baptist|adventist|presbyterian|methodist|nazarene|evangelical/i,
        /christian|calvary|gospel|church|trinity|covenant|bethany|bethel|grace|faith/i]
];
function denomOf(c) {
    const hayName = `${c.company || ''} ${c.name || ''} ${c.website || ''}`;
    const hayFull = `${hayName} ${c.clientNotes || ''} ${c.dossier || ''}`;
    for (const [key, occasions, anywhere, nameOnly] of DENOMS) {
        if (anywhere.test(hayFull) || nameOnly.test(hayName)) return { key, occasions };
    }
    return null;
}

async function saveViaPipeline(patch) {
    const body = JSON.stringify({
        jsonrpc: '2.0', id: 'import-ca-schools', method: 'tools/call',
        params: { name: 'pipeline', arguments: { action: 'save', judge: false, patch } }
    });
    const res = await fetch(SERVER, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`server http ${res.status}`);
    const j = await res.json();
    const txt = j && j.result && j.result.content && j.result.content[0] && j.result.content[0].text || '{}';
    try { return JSON.parse(txt); } catch (_) { return { raw: txt }; }
}

(async () => {
    const legacy = new PrismaClient({ datasources: { db: { url: LEGACY } } });
    const rows = await legacy.$queryRawUnsafe('SELECT * FROM Client');
    await legacy.$disconnect();

    // Group contacts by school (company), drop email-less contacts up front.
    const bySchool = new Map();
    let noEmail = 0;
    let notSchool = 0;
    for (const r of rows) {
        // The legacy file has stowaways: YFCON expo vendor rows (beauty brands)
        // that are not schools. This is the CA-SCHOOLS import; skip them.
        if (/yfcon/i.test(`${r.clientNotes || ''} ${r.dossier || ''} ${r.company || ''}`)) { notSchool++; continue; }
        if (!r.email || !String(r.email).includes('@')) { noEmail++; continue; }
        const key = (r.company || r.name || '').trim().toLowerCase();
        if (!key) continue;
        if (!bySchool.has(key)) bySchool.set(key, []);
        bySchool.get(key).push(r);
    }

    let imported = 0, blocked = 0, failed = 0;
    for (const contacts of bySchool.values()) {
        contacts.sort((a, b) => contactScore(a) - contactScore(b));
        const best = contacts[0];
        const others = contacts.slice(1);
        const denom = denomOf(best);

        const notesLines = [String(best.clientNotes || '').trim()];
        if (others.length) {
            notesLines.push('Other contacts: ' + others.map(o => `${o.name} <${o.email}> (${titleOf(o)})`).join('; '));
        }
        let dossier = String(best.dossier || '').trim();
        if (denom) {
            dossier += `\n[PERMANENT] Religious school (${denom.key}): pitch denomination-appropriate occasions (${denom.occasions}); NEVER pitch secular holidays like Halloween.`;
        }
        const patch = {
            name: best.name, email: best.email, phone: best.phone || undefined,
            company: best.company || best.name, website: best.website || undefined,
            clientNotes: notesLines.filter(Boolean).join('\n'),
            segment: denom ? `school:${denom.key}` : 'school',
            source: 'import:ca_schools',
            dossier: dossier || undefined
        };
        const label = `${patch.company} -- ${best.name} (${titleOf(best)})${others.length ? ` [+${others.length} more in notes]` : ''}${denom ? ` [${denom.key.toUpperCase()}]` : ''}`;

        if (DRY) { console.log('DRY  ', label); imported++; continue; }
        try {
            const resp = await saveViaPipeline(patch);
            if (resp.blocked) { blocked++; console.log('BLOCK', label, '--', resp.blockedReason || 'gate'); }
            else { imported++; console.log('OK   ', label); }
        } catch (e) {
            failed++; console.log('FAIL ', label, '--', e.message);
        }
    }
    console.log(`\n${DRY ? 'DRY RUN -- would import' : 'DONE --'} ${imported} school(s); ${blocked} blocked by gates; ${failed} failed; ${noEmail} contact(s) skipped (no email); ${notSchool} non-school stowaway(s) (YFCON vendors) excluded; ${rows.length} legacy rows in.`);
})().catch(e => { console.error('IMPORT FAILED:', e.message); process.exit(1); });
