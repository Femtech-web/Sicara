import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionOptions } from "../services/database/connection-options";

test("remote database connections verify TLS even if the dashboard URL omits SSL settings", () => {
  const options = connectionOptions("postgresql://test:synthetic@database.example:5432/postgres");
  assert.equal(options.ssl?.rejectUnauthorized, true);
  assert.equal(connectionOptions("postgresql://test:synthetic@database.example/postgres?sslmode=require").ssl?.rejectUnauthorized, true);
  assert.throws(() => connectionOptions("postgresql://test:synthetic@database.example/postgres?sslmode=disable"));
  assert.equal(connectionOptions("postgresql://test:synthetic@localhost/postgres?sslmode=disable").ssl, undefined);
});
