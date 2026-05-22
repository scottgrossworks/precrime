#!/usr/bin/env node
/**
 * reset-deployment-db.js
 *
 * One-shot reset to prepare a legacy precrime SQLite for re-enrichment by
 * the new tri-state scorer. Preserves terminal states; resets everything else.
 *
 * Usage:
 *   node scripts/reset-deployment-db.js <absolute-path-to-myproject.sqlite>
 *   node scripts/reset-deployment-db.js <db-path> --throttle 30
 *
 *   --throttle N   Set lastEnriched to now() minus N days instead of NULL,
 *                  so the enrichment-agent prioritizes truly-stale clients.
 *                  Default: clear to NULL (everything looks fresh).
 *
 * Safe to re-run. Idempotent.
 */

const path = require('path');
const fs = require('fs');

const dbArg = process.argv[2];
if (!dbArg) {
    console.error('Usage: node reset-deployment-db.js <absolute-path-to-myproject.sqlite> [--throttle N]');
    process.exit(1);
}
const dbPath = path.resolve(dbArg);
if (!fs.existsSync(dbPath)) {
    console.error(`DB not found: ${dbPath}`);
    process.exit(1);
}
const throttleIdx = process.argv.indexOf('--throttle');
const throttleDays = throttleIdx >= 0 ? parseInt(process.argv[throttleIdx + 1], 10) : null;

process.env.DATABASE_URL = 'file:' + dbPath;

// Load Prisma from the deployment's server (schema must match the DB)
const serverDir = path.resolve(path.dirname(dbPath), '..', 'server');
const prismaPath = path.join(serverDir, 'node_modules', '@prisma', 'client');
if (!fs.existsSync(prismaPath)) {
    console.error(`Prisma client not found at ${prismaPath}. Run setup.bat in the deployment first.`);
    process.exit(1);
}
const { PrismaClient } = require(prismaPath);
const prisma = new PrismaClient();

const TERMINAL_BOOKING = ['shared', 'taken', 'expired'];
const PRESERVE_CLIENT_DRAFT = ['sent', 'ready'];

async function snapshot(label) {
    const [bookings, clients] = await Promise.all([
        prisma.$queryRaw`SELECT status, COUNT(*) as n FROM Booking GROUP BY status`,
        prisma.$queryRaw`SELECT draftStatus, COUNT(*) as n FROM Client GROUP BY draftStatus`
    ]);
    const fmt = arr => arr.map(r => `${r.status ?? r.draftStatus ?? 'null'}=${Number(r.n)}`).join(', ');
    console.log(`\n${label}`);
    console.log(`  Booking.status:      ${fmt(bookings) || '(empty)'}`);
    console.log(`  Client.draftStatus:  ${fmt(clients) || '(empty)'}`);
}

(async () => {
    console.log(`DB: ${dbPath}`);
    await snapshot('BEFORE');

    // Fix the corrupted draftStatus rows first (e.g. "brewing, name: Abi Yarnell")
    const corrupted = await prisma.$executeRaw`
        UPDATE Client SET draftStatus='brewing'
        WHERE draftStatus LIKE 'brewing,%' OR draftStatus LIKE '%,%'`;
    if (corrupted > 0) console.log(`  Fixed ${corrupted} corrupted draftStatus row(s).`);

    // Bookings: preserve terminal states, reset all others to brewing with zero scores
    const bookingReset = await prisma.$executeRaw`
        UPDATE Booking
        SET status='brewing', bookingScore=0, factletScore=0
        WHERE status NOT IN ('shared','taken','expired')`;

    // Clients: preserve 'sent' and 'ready' drafts, reset everything else
    const clientReset = await prisma.$executeRaw`
        UPDATE Client
        SET draftStatus='brewing', dossierScore=0, intelScore=0, contactGate=0, warmthScore=0
        WHERE draftStatus IS NULL OR draftStatus NOT IN ('sent','ready')`;

    // lastEnriched: throttle or clear
    let enrichedUpdate;
    if (throttleDays !== null && !isNaN(throttleDays)) {
        const cutoff = new Date(Date.now() - throttleDays * 86400000).toISOString();
        enrichedUpdate = await prisma.$executeRaw`
            UPDATE Client SET lastEnriched=${cutoff}
            WHERE draftStatus='brewing'`;
        console.log(`  Set lastEnriched to ${throttleDays} days ago on ${enrichedUpdate} client(s).`);
    } else {
        enrichedUpdate = await prisma.$executeRaw`
            UPDATE Client SET lastEnriched=NULL
            WHERE draftStatus='brewing'`;
        console.log(`  Cleared lastEnriched on ${enrichedUpdate} client(s).`);
    }

    console.log(`\nReset:`);
    console.log(`  ${bookingReset} booking(s) -> brewing (terminal states preserved)`);
    console.log(`  ${clientReset} client(s)  -> brewing (sent/ready preserved)`);

    await snapshot('AFTER');

    console.log(`\nDone. Next: launch precrime in the deployment, then run:`);
    console.log(`  precrime__pipeline action="rescore" scope="all"`);

    await prisma.$disconnect();
})().catch(async (e) => {
    console.error('FATAL:', e.message);
    await prisma.$disconnect();
    process.exit(1);
});
