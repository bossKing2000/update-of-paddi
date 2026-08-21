const fs = require('fs');
const path = require('path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

describe('vendor enhancement backend contracts', () => {
  test('allows vendors to persist profile preferences', () => {
    expect(read('src', 'controllers', 'auth.controller.ts')).toContain('includeField("preferences", ["CUSTOMER", "VENDOR"])');
  });

  test('exposes promotion edit and reactivation routes', () => {
    const routes = read('src', 'routes', 'promoRoutes.ts');
    expect(routes).toContain('router.patch("/:id", updatePromo)');
    expect(routes).toContain('router.patch("/:id/reactivate", reactivatePromo)');
  });

  test('exposes the persistent vendor support-ticket route', () => {
    const server = read('src', 'server.ts');
    const schema = read('prisma', 'schema.prisma');
    expect(server).toContain('app.use("/api/vendor/support", vendorSupportRoutes)');
    expect(schema).toContain('model VendorSupportTicket');
    expect(fs.existsSync(path.join(__dirname, '..', 'prisma', 'migrations', '20260821110000_vendor_support_tickets', 'migration.sql'))).toBe(true);
  });

  test('accepts the three validated revenue-chart periods', () => {
    const controller = read('src', 'controllers', 'vendorDashboard.controller.ts');
    expect(controller).toContain('period must be thisWeek, lastWeek, or lastMonth');
  });
});
