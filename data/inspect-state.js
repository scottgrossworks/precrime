#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path');
const PRECRIME_ROOT = path.resolve(__dirname, '..');
const Database = require(path.join(PRECRIME_ROOT, 'server', 'node_modules', 'better-sqlite3'));

const args = process.argv.slice(2);
const getArg = f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const dbPath = path.resolve(getArg('--db') || path.join(PRECRIME_ROOT, 'data', 'myproject.sqlite'));

const stat = fs.statSync(dbPath);
const walP = dbPath + '-wal', shmP = dbPath + '-shm';
const walSize = fs.existsSync(walP) ? fs.statSync(walP).size : 0;
const shmSize = fs.existsSync(shmP) ? fs.statSync(shmP).size : 0;

console.log(`DB:    ${dbPath}`);
console.log(`  .sqlite      ${(stat.size/1024).toFixed(1)} KB`);
console.log(`  .sqlite-wal  ${(walSize/1024).toFixed(1)} KB  ${walSize ? '(unflushed writes)' : '(none)'}`);
console.log(`  .sqlite-shm  ${(shmSize/1024).toFixed(1)} KB  ${shmSize ? '(WAL index)' : '(none)'}`);
console.log('');

const db = new Database(dbPath, { readonly: true });

const counts = {
  Source:        db.prepare('SELECT COUNT(*) as n FROM Source').get().n,
  SourceScraped: db.prepare('SELECT COUNT(*) as n FROM Source WHERE scrapedAt IS NOT NULL').get().n,
  SourceClaimed: db.prepare('SELECT COUNT(*) as n FROM Source WHERE claimedAt IS NOT NULL').get().n,
  Client:        db.prepare('SELECT COUNT(*) as n FROM Client').get().n,
  Booking:       db.prepare('SELECT COUNT(*) as n FROM Booking').get().n,
  Factlet:       db.prepare('SELECT COUNT(*) as n FROM Factlet').get().n,
  ActiveSession: db.prepare("SELECT COUNT(*) as n FROM Session WHERE status='active'").get().n,
  SessionEvent:  db.prepare('SELECT COUNT(*) as n FROM SessionEvent').get().n,
};
console.log('Row counts:');
for (const [k,v] of Object.entries(counts)) console.log(`  ${k.padEnd(15)} ${v}`);

console.log('\nSource by channel (scraped / total):');
const byCh = db.prepare(`
  SELECT channel,
         COUNT(*) as total,
         SUM(CASE WHEN scrapedAt IS NOT NULL THEN 1 ELSE 0 END) as scraped,
         SUM(clientsFound) as totalFound
  FROM Source GROUP BY channel ORDER BY channel
`).all();
for (const r of byCh) console.log(`  ${r.channel.padEnd(10)} ${r.scraped}/${r.total}  sum(clientsFound): ${r.totalFound}`);

console.log('\nMost recent 5 sources scraped:');
const recent = db.prepare(`
  SELECT url, channel, scrapedAt, clientsFound, failedReason
  FROM Source WHERE scrapedAt IS NOT NULL
  ORDER BY scrapedAt DESC LIMIT 5
`).all();
for (const r of recent) console.log(`  [${r.channel.padEnd(9)}] cf=${String(r.clientsFound).padStart(3)} ${r.scrapedAt}  ${r.url}${r.failedReason?'  ('+r.failedReason+')':''}`);

db.close();
