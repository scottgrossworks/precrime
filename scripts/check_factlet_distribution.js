'use strict';
process.env.DATABASE_URL = 'file:C:\\Users\\Admin\\Desktop\\WKG\\TDS\\precrime\\data\\myproject.sqlite';
const { PrismaClient } = require('C:\\Users\\Admin\\Desktop\\WKG\\TDS\\precrime\\server\\node_modules\\@prisma\\client');
const prisma = new PrismaClient();

(async () => {
    const totalFactlets = await prisma.factlet.count();
    const totalLinks = await prisma.clientFactlet.count();
    const clientsWithFactlets = await prisma.client.findMany({
        where: { factlets: { some: {} } },
        select: { id: true, name: true, _count: { select: { factlets: true, bookings: true } } },
        orderBy: { factlets: { _count: 'desc' } }
    });

    console.log(`Total factlets: ${totalFactlets}`);
    console.log(`Total client-factlet links: ${totalLinks}`);
    console.log(`Clients WITH at least one factlet: ${clientsWithFactlets.length}\n`);

    console.log('Top clients by factlet count:');
    for (const c of clientsWithFactlets.slice(0, 25)) {
        console.log(`  ${(c.name || '(no name)').padEnd(40)} factlets=${c._count.factlets}  bookings=${c._count.bookings}`);
    }
    console.log('');

    // How many of these clients have bookings with leedId?
    const proven = await prisma.client.findMany({
        where: { bookings: { some: { leedId: { not: null } } } },
        include: { _count: { select: { factlets: true, bookings: true } }, bookings: { where: { leedId: { not: null } }, select: { title: true, leedId: true } } }
    });
    console.log(`\nClients tied to a previously-shared booking (leedId set): ${proven.length}`);
    for (const c of proven) {
        console.log(`  ${(c.name || '(no name)').padEnd(40)} factlets=${c._count.factlets}  bookings=${c._count.bookings}`);
    }
    await prisma.$disconnect();
})();
