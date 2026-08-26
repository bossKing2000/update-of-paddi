import prisma from '../src/lib/prisma';
import { fetchMostPopularProducts, fetchLiveProducts } from '../src/services/product.service';

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
  ];
  for (const v of vendors) {
    await (prisma as any).user.upsert({
      where: { id: v.id },
      update: { isLive: v.isLive },
      create: { ...v, password: 'x', isEmailVerified: true },
    });
  }
  await (prisma as any).productSchedule.deleteMany({
    where: { product: { id: { startsWith: 'c' } } },
  });
  await (prisma as any).product.deleteMany({
    where: { id: { startsWith: 'c' }, name: { startsWith: 'Dish c' } },
  });
  async function mkProduct(id: string, vendorId: string, mirror: boolean, schedule?: any) {
    await (prisma as any).product.create({
      data: {
        id, name: 'Dish ' + id, description: 'd', price: 100, category: 'LUNCH',
        images: ['i.jpg'], vendorId, isLive: mirror,
        productSchedule: schedule ? { create: schedule } : undefined,
      },
    });
  }

  // 1) active ONE_TIME + operating vendor
  await mkProduct('c1-active-onetime', 'v-live', true, {
    type: 'ONE_TIME', enabled: true,
    goLiveAt: new Date(now.getTime() - 10 * 60_000),
    takeDownAt: new Date(now.getTime() + 60 * 60_000),
    graceMinutes: 0,
  });
  // 2) expired ONE_TIME
  await mkProduct('c2-expired-onetime', 'v-live', true, {
    type: 'ONE_TIME', enabled: true,
    goLiveAt: new Date(now.getTime() - 120 * 60_000),
    takeDownAt: new Date(now.getTime() - 60 * 60_000),
    graceMinutes: 0,
  });
  // 3) active WEEKLY window covering right now (UTC)
  await mkProduct('c3-active-weekly', 'v-live', false, {
    type: 'WEEKLY', enabled: true,
    windows: { create: [{ dayOfWeek: now.getUTCDay(), startMinute: 0, endMinute: 1440 }] },
  });
  // 4) OFFLINE vendor + otherwise-active window
  await mkProduct('c4-offline-vendor', 'v-off', true, {
    type: 'ONE_TIME', enabled: true,
    goLiveAt: new Date(now.getTime() - 10 * 60_000),
    takeDownAt: new Date(now.getTime() + 60 * 60_000),
  });
  // 5) archived product with live window
  await (prisma as any).product.upsert({
    where: { id: 'c5-archived' },
    update: {},
    create: {
      id: 'c5-archived', name: 'Archived dish', description: 'd', price: 50, category: 'LUNCH',
      images: ['i.jpg'], vendorId: 'v-live', isLive: true, archived: true,
      productSchedule: { create: { type: 'ONE_TIME', enabled: true, goLiveAt: new Date(now.getTime() - 600_000), takeDownAt: new Date(now.getTime() + 600_000) } },
    },
  });

  const popular = await fetchMostPopularProducts({ skip: 0, take: 20 });
  const byId = new Map(popular.products.map((p: any) => [p.id, p]));

  check(
    '1. active ONE_TIME + online vendor -> orderable=true, vendorOperating=true',
    byId.get('c1-active-onetime')?.orderable === true &&
      byId.get('c1-active-onetime')?.vendorOperating === true,
  );
  const expired = byId.get('c2-expired-onetime');
  check(
    '2. expired ONE_TIME window stays DISCOVERABLE but NOT orderable',
    !!expired && expired.orderable === false && expired.isLive === false,
  );
  check(
    '3. active WEEKLY schedule -> present & orderable',
    byId.get('c3-active-weekly') !== undefined &&
      byId.get('c3-active-weekly')?.orderable === true,
  );
  check(
    '4. offline-vendor product excluded from marketplace listing',
    !byId.has('c4-offline-vendor') && !byId.has('c4-offline-vendor'),
  );
  check('5. archived product never listed', !byId.has('c5-archived'));

  const live = await fetchLiveProducts({ take: 20 });
  const liveIds = new Set(live.products.map((p: any) => p.id));
  check('6. LIVE listing contains active-window dishes', liveIds.has('c1-active-onetime'));
  check('7. LIVE listing excludes expired-window dish', !liveIds.has('c2-expired-onetime'));
  check('8. LIVE listing excludes offline-vendor product', !liveIds.has('c4-offline-vendor'));
  check('9. LIVE listing excludes archived product', !liveIds.has('c5-archived'));

  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error('VERIFY_FAILED:', e.message); process.exit(1); });
