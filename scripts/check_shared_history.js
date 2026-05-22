'use strict';
const path = require('path');
process.env.DATABASE_URL = 'file:C:\\Users\\Admin\\Desktop\\WKG\\TDS\\precrime\\data\\myproject.sqlite';
const { PrismaClient } = require('C:\\Users\\Admin\\Desktop\\WKG\\TDS\\precrime\\server\\node_modules\\@prisma\\client');
const prisma = new PrismaClient();

(async () => {
    const sharedTrue = await prisma.booking.count({ where: { shared: true } });
    const hasLeedId  = await prisma.booking.count({ where: { leedId: { not: null } } });
    const hasSharedAt= await prisma.booking.count({ where: { sharedAt: { not: null } } });
    const hasSharedTo= await prisma.booking.count({ where: { sharedTo: { not: null } } });

    const rows = await prisma.booking.findMany({
        where: { OR: [{ shared: true }, { leedId: { not: null } }, { sharedAt: { not: null } }] },
        select: { id: true, title: true, status: true, trade: true, shared: true, sharedTo: true, leedId: true, sharedAt: true, startDate: true }
    });

    console.log('shared=true            :', sharedTrue);
    console.log('leedId not null        :', hasLeedId);
    console.log('sharedAt not null      :', hasSharedAt);
    console.log('sharedTo not null      :', hasSharedTo);
    console.log('');
    console.log('=== rows with any share-history field set ===');
    for (const r of rows) {
        console.log(`  ${r.id}  status=${r.status}  shared=${r.shared}  leedId=${r.leedId || '-'}  sharedTo=${r.sharedTo || '-'}  trade=${r.trade}  title=${(r.title || '').slice(0,40)}`);
    }
    await prisma.$disconnect();
})();
