import { assertEquals } from "jsr:@std/assert";
import { checkSchemaVersion, SUPPORTED_SCHEMA_VERSION } from "./schema.ts";
import { CLOSE_CODES, ERROR_CODES } from "./errors.ts";

Deno.test("SUPPORTED_SCHEMA_VERSION es 1 (StarterKit actual)", () => {
  assertEquals(SUPPORTED_SCHEMA_VERSION, 1);
  assertEquals(checkSchemaVersion(SUPPORTED_SCHEMA_VERSION), {
    ok: true,
    version: 1,
  });
});

Deno.test("stored null/undefined => 1 legacy, aceptado", () => {
  assertEquals(checkSchemaVersion(null), { ok: true, version: 1 });
  assertEquals(checkSchemaVersion(undefined), { ok: true, version: 1 });
});

Deno.test("stored 0 y 1 son aceptados", () => {
  assertEquals(checkSchemaVersion(0), { ok: true, version: 0 });
  assertEquals(checkSchemaVersion(1), { ok: true, version: 1 });
});

Deno.test("stored > soportado se rechaza con ambas versiones", () => {
  assertEquals(checkSchemaVersion(2), { ok: false, stored: 2, supported: 1 });
  assertEquals(checkSchemaVersion(99), { ok: false, stored: 99, supported: 1 });
});

Deno.test("string numérico se coacciona (BIGINT textual de PG)", () => {
  assertEquals(checkSchemaVersion("1"), { ok: true, version: 1 });
  assertEquals(checkSchemaVersion("2"), { ok: false, stored: 2, supported: 1 });
});

Deno.test("valor no interpretable cae a legacy 1 (no bloquea carga)", () => {
  assertEquals(checkSchemaVersion("abc"), { ok: true, version: 1 });
  assertEquals(checkSchemaVersion(Number.NaN), { ok: true, version: 1 });
  assertEquals(checkSchemaVersion({}), { ok: true, version: 1 });
});

Deno.test("catálogo: SCHEMA_UNSUPPORTED y cierre 4415", () => {
  assertEquals(
    (ERROR_CODES as readonly string[]).includes("SCHEMA_UNSUPPORTED"),
    true,
  );
  assertEquals(CLOSE_CODES.SCHEMA_UPGRADE_REQUIRED, 4415);
});
