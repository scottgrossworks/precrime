#!/usr/bin/env node
/**
 * One-shot read of TDS DB state — clients by draftStatus, bookings by status.
 * No writes. Run from anywhere.
 */
'use strict';
const path = require('path');
const TDS_DB = 'C:\\Users\\Admin\\Desktop\\WKG\\TDS\\precrime\\data\\myproject.sqlite';
process.env.DATABASE_URL = 'file:' + TDS_DB;
const { PrismaClient } = require(path.join('C:\\Users\\Admin\\Desktop\\WKG\\TDS\\precrime\\server\\node_modules\\@prisma\\client'));
const prisma = new PrismaClient();

(async () => {
    const totalClients = await prisma.client.count();
    const readyDrafts  = await prisma.client.count({ where: { draftStatus: 'ready' } });
    const brewing      = await prisma.client.count({ where: { draftStatus: 'brewing' } });
    const noStatus     = await prisma.client.count({ where: { draftStatus: null } });
    const sent         = await prisma.client.count({ where: { draftStatus: 'sent' } });

    const totalBookings = await prisma.booking.count();
    const leedReady     = await prisma.booking.count({ where: { status: 'leed_ready' } });
    const newBookings   = await prisma.booking.count({ where: { status: 'new' } });
    const shared        = await prisma.booking.count({ where: { status: 'shared' } });
    const taken         = await prisma.booking.count({ where: { status: 'taken' } });
    const expired       = await prisma.booking.count({ where: { status: 'expired' } });

    const tradeBreakdown = await prisma.booking.groupBy({ by: ['trade'], _count: true });

    const totalSessions = await prisma.session.count();
    const totalEvents   = await prisma.sessionEvent.count();

    console.log('===== TDS DB STATE =====\n');
    console.log('CLIENTS:');
    console.log(`  total              : ${totalClients}`);
    console.log(`  draftStatus=ready  : ${readyDrafts}`);
    console.log(`  draftStatus=brewing: ${brewing}`);
    console.log(`  draftStatus=sent   : ${sent}`);
    console.log(`  draftStatus=null   : ${noStatus}`);
    console.log('');
    console.log('BOOKINGS:');
    console.log(`  total              : ${totalBookings}`);
    console.log(`  status=leed_ready  : ${leedReady}`);
    console.log(`  status=new         : ${newBookings}`);
    console.log(`  status=shared      : ${shared}`);
    console.log(`  status=taken       : ${taken}`);
    console.log(`  status=expired     : ${expired}`);
    console.log('');
    console.log('TRADES:');
    for (const t of tradeBreakdown) console.log(`  ${(t.trade || '(null)').padEnd(20)} ${t._count}`);
    console.log('');
    console.log('SESSIONS (new layer):');
    console.log(`  total sessions     : ${totalSessions}`);
    console.log(`  total events       : ${totalEvents}`);
    await prisma.$disconnect();
})();
