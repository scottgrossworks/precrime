'use strict';
const path = require('path');
const { spawn } = require('child_process');
const TDS = 'C:\\Users\\Admin\\Desktop\\WKG\\TDS\\precrime';
const env = { ...process.env, DATABASE_URL: 'file:' + path.join(TDS, 'data', 'myproject.sqlite'), PRECRIME_QUIET: '1' };

process.env.DATABASE_URL = env.DATABASE_URL;
const { PrismaClient } = require(path.join(TDS, 'server', 'node_modules', '@prisma', 'client'));
const prisma = new PrismaClient();

(async () => {
    // Get all 15 bookings that were previously shared (have leedId)
    const rows = await prisma.booking.findMany({
        where: { leedId: { not: null } },
        include: { client: { include: { factlets: true } } }
    });
    console.log(`Examining ${rows.length} previously-shared bookings\n`);
    for (const b of rows) {
        const c = b.client;
        const factletCount = c.factlets?.length || 0;
        const namedContact = !!(c.name && c.name.trim() && !/^(info|contact|hello|support|admin|events|inquiries|sales)$/i.test(c.name.trim()));
        const emailLocal = (c.email || '').split('@')[0].toLowerCase();
        const generic = ['info','contact','hello','support','admin','office','general','mail','help','team','webmaster','bookings','events','enquiries','inquiries','noreply','sales','marketing','pr','media','press','news','reception','management','operations','service','services','customerservice','customercare','care','feedback','staff'];
        const isGenericEmail = generic.includes(emailLocal);
        const namedEmail = !!c.email && !isGenericEmail;
        const hasZip = !!b.zip;
        const hasTrade = !!b.trade;
        const hasDate = !!b.startDate;
        const hasLocation = !!(b.location && b.location.length > 5);
        const futureDate = b.startDate && (new Date(b.startDate) > new Date());

        console.log(`-- ${(b.title || b.id).slice(0,55)}`);
        console.log(`   client: ${c.name || '-'} | email: ${c.email || '-'} | factlets: ${factletCount}`);
        console.log(`   trade=${hasTrade?'Y':'N'}  date=${hasDate?'Y':'N'}(${futureDate?'future':'past'})  zip=${hasZip?'Y':'N'}  loc=${hasLocation?'Y':'N'}  namedContact=${namedContact?'Y':'N'}  namedEmail=${namedEmail?'Y':'N'}`);
        console.log('');
    }
    await prisma.$disconnect();
})();
