import prisma from '../src/lib/prisma';
import { fetchMostPopularProducts, fetchLiveProducts } from '../src/services/product.service';

// Stage 1 verification (no product scheduling): orderability =
// vendor.isLive AND acceptingOrders !== false AND product.archived = false.

const now = new Date();
let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures++;
}

async function main() {
  const vendors = [
    { id: 'v-live', name: 'Live Kitchen', email: 'a@t.co', role: 'VENDOR' as const, isLive: true, deliveryPreferences: { acceptingOrders: true }, createdAt: now, updatedAt: now },
    { id: 'v-off', name: 'Offline Kitchen', email: 'b@t.co', role: 'VENDOR' as const, isLive: false, deliveryPreferences: {}, createdAt: now, updatedAt: now },
    { id: 'v-paused', name: 'Paused Kitchen', email: 'c@t.co', role: 'VENDOR' as const, isLive: true, deliveryPreferences: { acceptingOrders: false }, createdAt: now, updatedAt: now },
  ];
  for (const v of vendors) {
    await (prisma as any).user.upsert({
      where: { id: v.id },
      update: { isLive: v.isLive, deliveryPreferences: v.deliveryPreferences },
      create: { ...v, password: 'x', isEmailVerified: true },
    });
  }
  await (prisma as any).product.deleteMany({
    where: { id: { startsWith: 'c' }, name: { startsWith: 'Dish c' } },
  });
  async function mkProduct(id: string, vendorId: string, archived = false) {
    await (prisma as any).product.create({
      data: {
        id, name: 'Dish ' + id, description: 'd', price: 100, category: 'LUNCH',
        images: ['i.jpg'], vendorId, archived,
      },
    });
  }

  // 1) active vendor + unarchived product
  await mkProduct('c1-active', 'v-live');
  // 2) active vendor + archived product
  await mkProduct('c2-archived', 'v-live', true);
  // 3) offline vendor + unarchived product
  await mkProduct('c3-offline-vendor', 'v-off');
  // 4) paused vendor + unarchived product
  await mkProduct('c4-paused-vendor', 'v-paused');

  const popular = await fetchMostPopularProducts({ skip: 0, take: 5000 });
  const byId = new Map(popular.products.map((p: any) => [p.id, p]));

  check(
    '1. active vendor + unarchived -> orderable=true, vendorOperating=true',
    byId.get('c1-active')?.orderable === true &&
      byId.get('c1-active')?.vendorOperating === true,
  );
  check('2. archived product never listed', !byId.has('c2-archived'));
  check('3. offline-vendor product excluded from marketplace listing', !byId.has('c3-offline-vendor'));
  check('4. paused-vendor product excluded from marketplace listing', !byId.has('c4-paused-vendor'));

  const live = await fetchLiveProducts({ take: 5000 });
  const liveIds = new Set(live.products.map((p: any) => p.id));
  check('5. LIVE listing contains active-vendor dish', liveIds.has('c1-active'));
  check('6. LIVE listing excludes archived product', !liveIds.has('c2-archived'));
  check('7. LIVE listing excludes offline-vendor product', !liveIds.has('c3-offline-vendor'));
  check('8. LIVE listing excludes paused-vendor product', !liveIds.has('c4-paused-vendor'));

  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error('VERIFY_FAILED:', e.message); process.exit(1); });
