import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, customFetch, getApiErrorPositiveIntegerField } from "./custom-fetch";

function apiError(data: unknown, status = 409): ApiError {
  return new ApiError(
    new Response(null, { status }),
    data,
    { method: "POST", url: "/api/balance-topup-order" },
  );
}

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

  it("reads a pending payment id only from a valid conflict response", () => {
    expect(getApiErrorPositiveIntegerField(apiError({ paymentId: 42 }), "paymentId", 409)).toBe(42);
    expect(getApiErrorPositiveIntegerField(apiError({ paymentId: 42 }, 400), "paymentId", 409)).toBeNull();
    expect(getApiErrorPositiveIntegerField(apiError({ paymentId: 0 }), "paymentId", 409)).toBeNull();
    expect(getApiErrorPositiveIntegerField(apiError({ paymentId: 1.5 }), "paymentId", 409)).toBeNull();
    expect(getApiErrorPositiveIntegerField(apiError({ paymentId: "42" }), "paymentId", 409)).toBeNull();
    expect(getApiErrorPositiveIntegerField(new Error("network failure"), "paymentId", 409)).toBeNull();
  });
});