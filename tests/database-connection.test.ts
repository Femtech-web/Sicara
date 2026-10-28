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

test("serverless database CA uses a public PEM environment value without disabling verification", () => {
  const previous = process.env.DATABASE_SSL_CA;
  const previousFile = process.env.DATABASE_SSL_CA_FILE;
  try {
    delete process.env.DATABASE_SSL_CA_FILE;
    process.env.DATABASE_SSL_CA = '-----BEGIN CERTIFICATE-----\\nsynthetic-test-certificate\\n-----END CERTIFICATE-----';
    const options = connectionOptions('postgresql://test:synthetic@database.example/postgres?sslmode=require');
    assert.equal(options.ssl?.rejectUnauthorized, true);
    assert.equal(options.ssl?.ca, '-----BEGIN CERTIFICATE-----\nsynthetic-test-certificate\n-----END CERTIFICATE-----');
    assert.ok(!options.connectionString.includes('sslmode'));
    process.env.DATABASE_SSL_CA = 'not-a-certificate';
    assert.throws(() => connectionOptions('postgresql://test:synthetic@database.example/postgres'));
  } finally {
    if (previous === undefined) delete process.env.DATABASE_SSL_CA; else process.env.DATABASE_SSL_CA = previous;
    if (previousFile === undefined) delete process.env.DATABASE_SSL_CA_FILE; else process.env.DATABASE_SSL_CA_FILE = previousFile;
  }
});
