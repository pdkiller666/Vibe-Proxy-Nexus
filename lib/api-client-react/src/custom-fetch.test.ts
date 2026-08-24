import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, customFetch } from "./custom-fetch";

describe("customFetch API errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the pending payment id in ApiError.data for a duplicate top-up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "У вас уже есть ожидающий платёж на пополнение баланса.",
            paymentId: 42,
          }),
          {
            status: 409,
            statusText: "Conflict",
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    try {
      await customFetch("/api/balance-topup-order", {
        method: "POST",
        body: JSON.stringify({ amountRub: 100 }),
      });
      throw new Error("Expected customFetch to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(409);
      expect((error as ApiError).data).toEqual({
        error: "У вас уже есть ожидающий платёж на пополнение баланса.",
        paymentId: 42,
      });
    }
  });
});