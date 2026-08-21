const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('customer storefront contract surface', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'productController.ts'), 'utf8');

  it('supports a vendorId-filtered public product listing for storefronts', () => {
    assert.match(source, /const vendorIdQuery = req\.query\.vendorId/);
    assert.match(source, /where\.vendorId = vendorIdQuery/);
    assert.match(source, /products:vendor:/);
  });

  it('returns displayable vendor identity with public product cards', () => {
    assert.match(source, /brandName: true/);
    assert.match(source, /vendor: p\.vendor/);
  });
});
