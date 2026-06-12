// sync-config.js -- reads VALUE_PROP.md masthead, writes to DB Config.
// VALUE_PROP.md is the sole source for product/sales fields (companyName,
// companyEmail, businessDescription, defaultTrade, leedzEmail, pitch).
// precrime_config.json is NEVER read here -- it owns runtime/API config only.
// SQLite Config is an internal runtime mirror, not a user surface.
// If VALUE_PROP.md is missing or incomplete, exits 0 silently.
// The init-wizard handles prompting for missing fields interactively.
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const vpPath = path.resolve(__dirname, '..', 'DOCS', 'VALUE_PROP.md');
if (!fs.existsSync(vpPath)) { process.exit(0); }

const text = fs.readFileSync(vpPath, 'utf8');

const seller = (text.match(/\*\*Seller:\*\*\s*(.+)/)?.[1] || '').trim();
const email = (text.match(/\*\*Email:\*\*\s*(.+)/)?.[1] || '').trim();
const pitchMatch = text.match(/## THE PITCH[^\n]*\n+([\s\S]*?)(?=\n---|\n## )/);
const pitch = (pitchMatch?.[1] || '').trim();

// SIGNATURE: capture any markdown heading named "signature", any case.
const sigMatch = text.match(/^#{2,6}\s+signature\b[^\n]*\n+([\s\S]*?)(?=\n---|\n#{1,6}\s+|$)/im);
let signature = (sigMatch?.[1] || '').replace(/<!--[\s\S]*?-->/g, '').trim();
const sigUsable = signature && signature.split(/\r?\n/).some(line => line.trim() && !/\[YOUR/i.test(line));

const patch = {};
if (seller && !seller.match(/\[YOUR/i)) patch.companyName = seller;
if (email && !email.match(/\[YOUR/i)) patch.companyEmail = email;
if (pitch && !pitch.match(/\[YOUR|\[Describe|\[FILL/i)) patch.businessDescription = pitch;
if (sigUsable) patch.signature = signature;

// Trade: explicit VALUE_PROP `**Trade:**` wins. Whole-file fallback is unsafe:
// relevance examples can mention other trades and must not override the masthead.
const trades = ["activity party","airbrush","baker","balloons","bartender","braider","car detailer","caricatures","caterer","concessions","dancer","decor","dj","drones","esthetician","event rentals","eyelashes","face painter","flowers","gaming trailer","hair","henna","inflatables","juggler","lighting","magician","makeup","massage","musician","nails","photo booth","photographer","restrooms","security","tennis","tent rental","trainer","valet","videographer","yoga"];
const explicitTrade = (text.match(/\*\*Trade:\*\*\s*(.+)/i)?.[1] || '').trim().toLowerCase();
let matchedTrade = trades.find(t => explicitTrade === t || explicitTrade.includes(t));
// Fallback only to title/seller line, not body/relevance examples.
const titleLine = (text.match(/^#.*$/m)?.[0] || '').toLowerCase();
const sellerLine = (text.match(/\*\*Seller:\*\*\s*(.+)/)?.[1] || '').toLowerCase();
const titleText = titleLine + ' ' + sellerLine;
if (!matchedTrade) matchedTrade = trades.find(t => titleText.includes(t));
if (matchedTrade) patch.defaultTrade = matchedTrade;

// Marketplace-only deployment -- always leedz_api
patch.defaultBookingAction = 'leedz_api';

// Enable pipeline features -- without these, client creation and posting are blocked
patch.leadCaptureEnabled = true;
patch.marketplaceEnabled = true;

// Active entities -- marketplace needs both clients and bookings
patch.activeEntities = JSON.stringify(["client", "booking"]);

// leedzEmail -- Leedz API uses seller email for auth. Same as companyEmail.
if (patch.companyEmail) patch.leedzEmail = patch.companyEmail;

// leedzSession -- auto-generate JWT if we have an email (marketplace posting requires this)
if (patch.leedzEmail) {
  const crypto = require('crypto');
  const secret = '648373eeea08d422032db0d1e61a1bc096fe08dd2729ce611092c7a1af15d09c';
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header  = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({
    email: patch.leedzEmail,
    type: 'session',
    exp: Math.floor(Date.now() / 1000) + 365 * 24 * 3600
  });
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  patch.leedzSession = `${header}.${payload}.${sig}`;
}

// Report exactly what was parsed so a silent failure becomes visible. Without
// this, the launcher prints "Config synced" while Config is actually empty,
// and the wizard then asks the user to paste fields that ARE in VALUE_PROP.md.
const parsed = {
  Trade:    !!patch.defaultTrade,
  Seller:   !!patch.companyName,
  Email:    !!patch.companyEmail,
  Pitch:    !!patch.businessDescription,
  Signature:!!patch.signature
};
const missing = Object.entries(parsed).filter(([, ok]) => !ok).map(([k]) => k);
if (missing.length) {
  console.error(`[sync-config] WARNING: VALUE_PROP.md is missing or unreadable for: ${missing.join(', ')}`);
  console.error(`[sync-config] Required markers: **Trade:**, **Seller:**, **Email:**, ## THE PITCH block, signature heading (## SIGNATURE preferred; legacy ### Signature accepted).`);
  console.error(`[sync-config] File scanned: ${vpPath}`);
}

if (Object.keys(patch).length === 0) {
  console.error('[sync-config] FATAL: no fields parsed from VALUE_PROP.md. Config NOT updated.');
  process.exit(1);
}

const prisma = new PrismaClient();

async function main() {
  let cfg = await prisma.config.findFirst();
  if (cfg) {
    await prisma.config.update({ where: { id: cfg.id }, data: patch });
  } else {
    await prisma.config.create({ data: patch });
  }
  console.log(`Config synced from VALUE_PROP.md (wrote: ${Object.keys(patch).sort().join(', ')})`);
}

main().catch(err => {
  console.error('[sync-config] FATAL: write to Config failed:', err.message);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
