// sync-config.js -- reads VALUE_PROP.md masthead, writes to DB Config.
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

const patch = {};
if (seller && !seller.match(/\[YOUR/i)) patch.companyName = seller;
if (email && !email.match(/\[YOUR/i)) patch.companyEmail = email;
if (pitch && !pitch.match(/\[YOUR|\[Describe|\[FILL/i)) patch.businessDescription = pitch;

// Auto-detect trade from product name/title
const trades = ["activity party","airbrush","baker","balloons","bartender","braider","car detailer","caricatures","caterer","concessions","dancer","decor","dj","drones","esthetician","event rentals","eyelashes","face painter","flowers","gaming trailer","hair","henna","inflatables","juggler","lighting","magician","makeup","massage","musician","nails","photo booth","photographer","restrooms","security","tennis","tent rental","trainer","valet","videographer","yoga"];
// Trade detection: check title/first line first, then full text
const titleLine = (text.match(/^#.*$/m)?.[0] || '').toLowerCase();
const sellerLine = (text.match(/\*\*Seller:\*\*\s*(.+)/)?.[1] || '').toLowerCase();
const titleText = titleLine + ' ' + sellerLine;
const textLower = text.toLowerCase();
// Priority: match in title/seller line first (most specific)
let matchedTrade = trades.find(t => titleText.includes(t));
// Fallback: match in full text (less reliable)
if (!matchedTrade) matchedTrade = trades.find(t => textLower.includes(t));
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

if (Object.keys(patch).length === 0) { process.exit(0); }

const prisma = new PrismaClient();

async function main() {
  let cfg = await prisma.config.findFirst();
  if (cfg) {
    await prisma.config.update({ where: { id: cfg.id }, data: patch });
  } else {
    await prisma.config.create({ data: patch });
  }
  console.log('Config synced from VALUE_PROP.md');
}

main().catch(() => {}).finally(() => prisma.$disconnect());
