/**
 * AUTH-2 — the OpenAPI document must document the passwordless email OTP login
 * endpoints that were implemented without documentation.
 *
 * These tests assert the DOCUMENT against the IMPLEMENTED behaviour, so the
 * two cannot drift apart silently again. The endpoints are public, so each
 * operation must explicitly declare `security: []` (an empty array overrides
 * the top-level `security: [{ bearerAuth: [] }]` requirement rather than
 * inheriting it).
 *
 * Reference: OpenAPI Specification 3.0.3,
 * https://spec.openapis.org/oas/v3.0.3.html — operation-level `security` overrides
 * top-level security; an empty array removes the top-level requirement entirely.
 */
import { openApiDocument } from "../../src/docs/openapi";

type Path = Record<string, any>;

const paths = openApiDocument.paths as unknown as Record<string, Path>;

const operation = (path: string, method = "post") => {
  const op = paths[path]?.[method];
  if (!op) throw new Error(`Missing OpenAPI path: ${method.toUpperCase()} ${path}`);
  return op;
};

const bodyProperties = (path: string, method = "post") => {
  const content = operation(path, method).requestBody?.content?.["application/json"];
  if (!content) throw new Error(`Missing application/json request body on ${method.toUpperCase()} ${path}`);
  return (content.schema as Record<string, any>)?.properties ?? {};
};

describe("email OTP login — documented paths", () => {
  it("documents POST /auth/email/login/request-otp", () => {
    const op = operation("/auth/email/login/request-otp");
    expect(op.tags).toContain("Auth");
    expect(op.summary).toContain("one-time");
    expect(op.security).toEqual([]);
  });

  it("documents POST /auth/email/login/verify-otp", () => {
    const op = operation("/auth/email/login/verify-otp");
    expect(op.tags).toContain("Auth");
    expect(op.summary).toContain("Verify");
    expect(op.security).toEqual([]);
  });

  it("both endpoints are public (explicit empty security array)", () => {
    for (const path of ["/auth/email/login/request-otp", "/auth/email/login/verify-otp"]) {
      expect(operation(path).security).toEqual([]);
    }
  });
});

describe("email OTP login — request bodies", () => {
  it("request-otp requires only the email address", () => {
    const props = bodyProperties("/auth/email/login/request-otp");
    expect(props.email).toMatchObject({ type: "string", format: "email" });
    expect(props.email.required).toBeUndefined(); // required is at schema level
    expect((operation("/auth/email/login/request-otp").requestBody as any).content["application/json"].schema.required).toEqual(["email"]);
  });

  it("verify-otp requires email and a six-digit OTP", () => {
    const props = bodyProperties("/auth/email/login/verify-otp");
    expect(props.email).toMatchObject({ type: "string", format: "email" });
    expect(props.otp).toMatchObject({ type: "string", minLength: 6, maxLength: 6 });
    const schema = (operation("/auth/email/login/verify-otp").requestBody as any).content["application/json"].schema;
    expect(schema.required).toEqual(["email", "otp"]);
  });
});

describe("email OTP login — responses", () => {
  it("request-otp documents a single generic 200 (no account-enumerating shape)", () => {
    const responses = operation("/auth/email/login/request-otp").responses;
    expect(responses["200"]).toBeDefined();
    expect(String(responses["200"].description)).toContain("same generic");
    expect(responses["200"].content["application/json"].schema).toMatchObject({ type: "object" });
    // No account-specific fields (e.g. user, accessToken) are documented here.
    const schema = responses["200"].content["application/json"].schema as Record<string, any>;
    expect(schema.properties).toBeUndefined();
  });

  it("verify-otp documents 200 session issuance", () => {
    const responses = operation("/auth/email/login/verify-otp").responses;
    expect(responses["200"]).toBeDefined();
    expect(String(responses["200"].description)).toContain("session");
  });

  it("both endpoints document validation and rate-limit failures", () => {
    for (const path of ["/auth/email/login/request-otp", "/auth/email/login/verify-otp"]) {
      const responses = operation(path).responses;
      expect(responses["422"]).toBeDefined();
      expect(responses["429"]).toBeDefined();
      expect(responses["503"]).toBeDefined();
    }
  });

  it("verify-otp documents invalid/expired-code and unknown-account responses", () => {
    const responses = operation("/auth/email/login/verify-otp").responses;
    expect(responses["400"]).toBeDefined();
    expect(String(responses["400"].description)).toMatch(/invalid|expired|account/i);
  });

  it("verify-otp documents 403 when the account is blocked", () => {
    const responses = operation("/auth/email/login/verify-otp").responses;
    expect(responses["403"]).toBeDefined();
    const content = responses["403"].content["application/json"];
    expect(content).toBeDefined();
    expect(content.schema).toMatchObject({ $ref: "#/components/schemas/ErrorResponse" });
  });

  it("every documented error response reuses the shared ErrorResponse schema", () => {
    for (const path of ["/auth/email/login/request-otp", "/auth/email/login/verify-otp"]) {
      const responses = operation(path).responses;
      for (const code of ["422", "429", "503"]) {
        const content = responses[code]?.content?.["application/json"];
        expect(content?.schema).toMatchObject({ $ref: "#/components/schemas/ErrorResponse" });
      }
    }
  });
});
