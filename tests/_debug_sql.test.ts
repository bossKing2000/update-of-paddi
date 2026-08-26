jest.mock('../src/lib/prisma', () => ({
  __esModule: true,
  default: { $queryRawUnsafe: jest.fn().mockResolvedValue([]) },
}));
import prisma from '../src/lib/prisma';
import { fetchMostPopularProducts } from '../src/services/product.service';

test('capture', async () => {
  const m = (prisma as any).$queryRawUnsafe as jest.Mock;
  await fetchMostPopularProducts({ skip: 0, take: 20 });
  const sqls = m.mock.calls.map((c: any[]) => c[0] as string);
  for (const sql of sqls) {
    let depth = 0;
    for (const ch of sql.replace(/'[^']*'/g, "''")) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
    }
    console.log('PAREN_DEPTH:', depth);
    console.log('SQL>>>', sql);
  }
  expect(sqls.length).toBe(2);
});
