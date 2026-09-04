import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { runM44ReferralLedgerRepair } from "../../../../deploy/amvera-all-in-one/heal-schema-m44.mjs";

const schemaName = `m44_test_${randomBytes(6).toString("hex")}`;
const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;

describe("Amvera M-44 schema repair", () => {
  let client;

  beforeAll(async () => {
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await client.query(`
      CREATE TABLE users (
        id integer PRIMARY KEY,
        balance_kopecks integer NOT NULL,
        referred_by_user_id integer
      );
      CREATE TABLE payments (
        id integer PRIMARY KEY
      );
      CREATE TABLE balance_transactions (
        id integer PRIMARY KEY,
        user_id integer NOT NULL,
        amount_kopecks integer NOT NULL,
        type text NOT NULL,
        payment_id integer
      );
      INSERT INTO users (id, balance_kopecks, referred_by_user_id)
      VALUES (1, 1000, NULL);
      INSERT INTO payments (id) VALUES (7);
      INSERT INTO balance_transactions (id, user_id, amount_kopecks, type, payment_id)
      VALUES
        (1, 1, 100, 'referral', 7),
        (2, 1, 100, 'referral', 7);
    `);
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA ${quoteIdentifier(schemaName)} CASCADE`);
    client.release();
  });

  it("rolls back an interrupted repair and debits only once across reruns", async () => {
    await expect(
      runM44ReferralLedgerRepair(client, {
        beforeCommit: async () => {
          throw new Error("simulated startup interruption");
        },
      }),
    ).rejects.toThrow("simulated startup interruption");

    let result = await client.query("SELECT balance_kopecks FROM users WHERE id = 1");
    expect(result.rows[0].balance_kopecks).toBe(1000);
    result = await client.query(
      "SELECT count(*)::integer AS count FROM balance_transactions WHERE type = 'referral'",
    );
    expect(result.rows[0].count).toBe(2);

    await runM44ReferralLedgerRepair(client);
    result = await client.query("SELECT balance_kopecks FROM users WHERE id = 1");
    expect(result.rows[0].balance_kopecks).toBe(900);
    result = await client.query(
      "SELECT count(*)::integer AS count FROM balance_transactions WHERE type = 'referral'",
    );
    expect(result.rows[0].count).toBe(1);

    await runM44ReferralLedgerRepair(client);
    result = await client.query("SELECT balance_kopecks FROM users WHERE id = 1");
    expect(result.rows[0].balance_kopecks).toBe(900);
    result = await client.query(
      "SELECT count(*)::integer AS count FROM balance_transactions WHERE type = 'referral'",
    );
    expect(result.rows[0].count).toBe(1);
  });
});