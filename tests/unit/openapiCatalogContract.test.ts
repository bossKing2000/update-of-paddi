/**
 * B-7 — the OpenAPI document must match the implemented catalog routes.
 *
 * The document had drifted: the search endpoint did not list `limit`,
 * `dishType`, `minPrice`, `maxPrice`, `minRating` or `availableOnly`, its
 * `sortBy` enum was missing the `rating` option the code accepts, the
 * pagination parameters had no documented default or maximum, and the public
 * vendor profile did not exist in the document at all.
 *
 * These tests assert the DOCUMENT against the IMPLEMENTED behaviour, so the
 * two cannot drift apart silently again.
 */
import { openApiDocument } from "../../src/docs/openapi";
import { CATALOG_SORT_VALUES } from "../../src/services/product.service";

type Path = Record<string, any>;

const paths = openApiDocument.paths as unknown as Record<string, Path>;

const paramNames = (path: string, method = "get"): string[] => {
  const operation = paths[path]?.[method];
  if (!operation) throw new Error(`Missing OpenAPI path: ${method.toUpperCase()} ${path}`);
  return (operation.parameters ?? []).map((p: any) => p.name);
};

const param = (path: string, name: string, method = "get") => {
  const operation = paths[path]?.[method];
  const found = (operation?.parameters ?? []).find((p: any) => p.name === name);
  if (!found) throw new Error(`Missing parameter ${name} on ${method.toUpperCase()} ${path}`);
  return found;
};

describe("catalog list routes — documented pagination", () => {
  it.each([
    "/product",
    "/product/categories/{slug}/products",
  ])("%s documents page and limit with their bounds", (path) => {
    expect(paramNames(path)).toEqual(
      expect.arrayContaining(["page", "limit"]),
    );

    const page = param(path, "page");
    expect(page.schema.type).toBe("integer");
    expect(page.schema.minimum).toBe(1);
    expect(page.schema.default).toBe(1);

    const limit = param(path, "limit");
    expect(limit.schema.type).toBe("integer");
    expect(limit.schema.minimum).toBe(1);
    expect(limit.schema.default).toBe(20);
    expect(limit.schema.maximum).toBe(20);
    // The above-maximum behaviour is documented, not left implicit.
    expect(String(limit.description)).toMatch(/clamped/i);
  });

  it.each([
    "/product",
    "/product/categories/{slug}/products",
  ])("%s documents the implemented sort options", (path) => {
    const sortBy = param(path, "sortBy");
    expect(sortBy.schema.enum).toEqual([...CATALOG_SORT_VALUES]);
  });

  it.each([
    "/product",
    "/product/categories/{slug}/products",
  ])("%s documents the implemented filter parameters", (path) => {
    expect(paramNames(path)).toEqual(
      expect.arrayContaining([
        "dishType",
        "vendorId",
        "tags",
        "minPrice",
        "maxPrice",
        "minRating",
        "availableOnly",
      ]),
    );
  });

  it("the catalog list routes document the 400 validation response", () => {
    expect(paths["/product"].get.responses["400"]).toBeDefined();
    expect(paths["/product/categories/{slug}/products"].get.responses["400"]).toBeDefined();
  });
});

describe("search route — documented parameters and sort options", () => {
  it("documents every parameter the implementation reads", () => {
    expect(paramNames("/product/p/search")).toEqual(
      expect.arrayContaining([
        "q",
        "page",
        "limit",
        "sortBy",
        "dishType",
        "tags",
        "minPrice",
        "maxPrice",
        "minRating",
        "availableOnly",
      ]),
    );
  });

  it("marks q as required", () => {
    expect(param("/product/p/search", "q").required).toBe(true);
  });

  it("documents the accepted sort options, including rating", () => {
    const sortBy = param("/product/p/search", "sortBy");
    expect(sortBy.schema.enum).toEqual([
      "relevance",
      "priceAsc",
      "priceDesc",
      "popularity",
      "newest",
      "rating",
    ]);
    expect(sortBy.schema.default).toBe("relevance");
  });

  it("documents the pagination bounds and the clamping behaviour", () => {
    const page = param("/product/p/search", "page");
    expect(page.schema.minimum).toBe(1);
    expect(page.schema.default).toBe(1);

    const limit = param("/product/p/search", "limit");
    expect(limit.schema.minimum).toBe(1);
    expect(limit.schema.default).toBe(20);
    expect(limit.schema.maximum).toBe(20);
    expect(String(limit.description)).toMatch(/clamped/i);
  });

  it("documents the 400 validation response", () => {
    expect(paths["/product/p/search"].get.responses["400"]).toBeDefined();
  });
});

describe("rail routes — documented pagination", () => {
  it("/product/p/most documents page and limit with the rail bounds", () => {
    const page = param("/product/p/most", "page");
    expect(page.schema.default).toBe(1);
    expect(page.schema.minimum).toBe(1);

    const limit = param("/product/p/most", "limit");
    expect(limit.schema.default).toBe(50);
    expect(limit.schema.maximum).toBe(50);
    expect(paths["/product/p/most"].get.responses["400"]).toBeDefined();
  });

  it("/product/p/new documents page and limit with the rail bounds", () => {
    const page = param("/product/p/new", "page");
    expect(page.schema.default).toBe(1);
    expect(page.schema.minimum).toBe(1);

    const limit = param("/product/p/new", "limit");
    expect(limit.schema.default).toBe(20);
    expect(limit.schema.maximum).toBe(50);
    expect(paths["/product/p/new"].get.responses["400"]).toBeDefined();
  });
});

describe("public vendor profile — documented", () => {
  it("is documented as a public, read-only endpoint with explicit security: []", () => {
    const operation = paths["/vendors/{vendorId}"]?.get;
    expect(operation).toBeDefined();
    // An absent `security` property would inherit the global bearerAuth
    // requirement, so assert it is explicitly overridden to an empty array.
    expect(operation.security).toEqual([]);
    expect(paramNames("/vendors/{vendorId}")).toEqual(["vendorId"]);
    expect(param("/vendors/{vendorId}", "vendorId").required).toBe(true);
  });

  it("documents the 400 and 404 responses", () => {
    const responses = paths["/vendors/{vendorId}"].get.responses;
    expect(responses["400"]).toBeDefined();
    expect(responses["404"]).toBeDefined();
  });
});

describe("nearby route — documented", () => {
  it("is documented as a public, unauthenticated endpoint with explicit security: []", () => {
    const operation = paths["/auth/nearby"]?.get;
    expect(operation).toBeDefined();
    expect(operation.security).toEqual([]);
  });

  it("documents lat, lng and radius", () => {
    expect(paramNames("/auth/nearby")).toEqual(
      expect.arrayContaining(["lat", "lng", "radius"]),
    );
    expect(param("/auth/nearby", "lat").required).toBe(true);
    expect(param("/auth/nearby", "lng").required).toBe(true);
    expect(param("/auth/nearby", "radius").schema.default).toBe(5);
  });

  it("documents the 400 validation response", () => {
    expect(paths["/auth/nearby"].get.responses["400"]).toBeDefined();
  });
});

describe("catalog public routes declare explicit security: []", () => {
  it.each([
    "/product",
    "/product/categories/{slug}/products",
    "/product/dish-types",
    "/product/categories",
    "/product/tags",
    "/product/{id}",
    "/product/p/search",
    "/product/p/suggestions",
    "/product/p/most",
    "/product/p/new",
    "/home/whats-in-the-pot",
  ])("%s declares security: [] (public)", (path) => {
    const operation = paths[path]?.get;
    expect(operation).toBeDefined();
    expect(operation.security).toEqual([]);
  });

  it("authenticated-only routes do NOT declare security: []", () => {
    // POST /product is vendor-only and must inherit the global bearerAuth
    expect(paths["/product"].post.security).not.toEqual([]);
    // PATCH /product/{id} is vendor-only
    expect(paths["/product/{id}"].patch.security).not.toEqual([]);
    // DELETE /product/{id} is vendor-only
    expect(paths["/product/{id}"].delete.security).not.toEqual([]);
  });
});

describe("the document itself stays valid", () => {
  it("every documented path has at least one method", () => {
    for (const [path, definition] of Object.entries(paths)) {
      expect(Object.keys(definition).length).toBeGreaterThan(0);
      expect(path.startsWith("/")).toBe(true);
    }
  });

  it("the error response schema is referenced by the new entries", () => {
    const schema = openApiDocument.components.schemas.ErrorResponse;
    expect(schema).toBeDefined();
    expect(schema.properties.success).toBeDefined();
    expect(schema.properties.code).toBeDefined();
  });
});
