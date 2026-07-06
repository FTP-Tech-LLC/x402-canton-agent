import { describe, it, expect, vi } from "vitest";
import type { PaymentRequirements } from "@ftptech/x402-canton-core";
import { atomicToDecimalCC } from "@ftptech/x402-canton-core";
import { ExactCantonScheme, SchemeMethodMismatchError } from "./scheme.js";
import type { CantonSigner } from "./signer.js";

const PAYER = "agent::1220abc";
const MERCHANT = "merchant::1220def";
const FACILITATOR = "ftp_facilitator::1220fff";
const SYNC = "global-domain::1220xyz";

function makeTfRequirements(): PaymentRequirements {
  return {
    scheme: "exact",
    network: "canton:devnet",
    amount: "2000000000000",
    asset: `${FACILITATOR}::TestToken`,
    payTo: MERCHANT,
    maxTimeoutSeconds: 60,
    extra: {
      assetTransferMethod: "transfer-factory" as const,
      feePayer: FACILITATOR,
      synchronizerId: SYNC,
      instrumentId: { admin: FACILITATOR, id: "TestToken" },
      executeBeforeSeconds: 120,
    },
  };
}

function makeTfSigner(
  result: {
    submissionRef?: string;
    preparedTxHash?: string;
  } = {}
): CantonSigner {
  return {
    party: PAYER,
    signTransferFactory: vi.fn().mockResolvedValue({
      payerParty: PAYER,
      submissionRef: result.submissionRef ?? "REF-default",
      preparedTxHash: result.preparedTxHash ?? "aabbccdd",
    }),
  };
}

describe("ExactCantonScheme.createPaymentPayload", () => {
  // -----------------------------------------------------------------
  // General
  // -----------------------------------------------------------------

  it("network field in returned payload matches requirements.network", async () => {
    const customReqs: PaymentRequirements = {
      ...makeTfRequirements(),
      network: "canton:mainnet",
    };
    const signer = makeTfSigner();
    const scheme = new ExactCantonScheme(signer);

    const env = await scheme.createPaymentPayload(customReqs, {
      url: "https://api.example.com/data",
    });

    expect(env.network).toBe("canton:mainnet");
  });

  it("ExactCantonScheme: throws Error (not CantonError) for unsupported assetTransferMethod 'exact-solana'", async () => {
    const signer = makeTfSigner();
    const scheme = new ExactCantonScheme(signer);

    const badReqs: PaymentRequirements = {
      ...makeTfRequirements(),
      extra: {
        assetTransferMethod: "exact-solana" as any,
        feePayer: FACILITATOR,
        synchronizerId: SYNC,
      } as any,
    };

    await expect(
      scheme.createPaymentPayload(badReqs, { url: "https://api.example.com/data" })
    ).rejects.toThrow("unsupported assetTransferMethod");
    // Must be a plain Error, not a CantonError or other subclass
    await expect(
      scheme.createPaymentPayload(badReqs, { url: "https://api.example.com/data" })
    ).rejects.toBeInstanceOf(Error);
  });
});

// FEATURE A — unit-by-scheme seam: the amount handed to the signer (which stamps
// it onto the on-ledger Daml Decimal) is derived from the WIRE amount keyed by
// the requirements' scheme.
describe("ExactCantonScheme — unit-by-scheme amount seam (FEATURE A)", () => {
  const captureAmount = (): {
    signer: CantonSigner;
    seen: () => string | undefined;
  } => {
    let seen: string | undefined;
    const signer: CantonSigner = {
      party: PAYER,
      signTransferFactory: vi.fn().mockImplementation((input) => {
        seen = input.amount;
        return Promise.resolve({
          payerParty: PAYER,
          submissionRef: "REF-seam",
          preparedTxHash: "aabb",
        });
      }),
    };
    return { signer, seen: () => seen };
  };

  it("scheme \"exact\": the signer receives the on-ledger Daml Decimal converted from the ATOMIC wire amount (200 CC)", async () => {
    const { signer, seen } = captureAmount();
    // 200 CC in atomic units (1 CC = 1e10).
    const wire = "2000000000000";
    const reqs: PaymentRequirements = {
      ...makeTfRequirements(),
      scheme: "exact",
      amount: wire,
    };
    await scheme0(signer, reqs);
    // The signer stamps the on-ledger Daml Decimal derived from the wire atomic.
    expect(seen()).toBe(atomicToDecimalCC(wire));
    expect(seen()).toBe("200.0000000000");
  });

  it("atomic scheme \"exact\": the signer receives the on-ledger Daml Decimal converted from the ATOMIC wire amount", async () => {
    const { signer, seen } = captureAmount();
    const reqs: PaymentRequirements = {
      ...makeTfRequirements(),
      scheme: "exact",
      // 0.0123456789 CC in atomic units.
      amount: "123456789",
    };
    await scheme0(signer, reqs);
    expect(seen()).toBe("0.0123456789");
  });

  it("atomic scheme \"exact\": the emitted envelope scheme is \"exact\"", async () => {
    const { signer } = captureAmount();
    const reqs: PaymentRequirements = {
      ...makeTfRequirements(),
      scheme: "exact",
      amount: "123456789",
    };
    const env = await scheme0(signer, reqs);
    expect(env.scheme).toBe("exact");
  });

  function scheme0(signer: CantonSigner, reqs: PaymentRequirements) {
    return new ExactCantonScheme(signer).createPaymentPayload(reqs, {
      url: "https://api.example.com/data",
    });
  }
});

describe("ExactCantonScheme transfer-factory (V3) arm", () => {
  function tfRequirements(): PaymentRequirements {
    return {
      scheme: "exact",
      network: "canton:mainnet",
      amount: "2500000000", // atomic 0.25 CC
      asset: "CC",
      payTo: MERCHANT,
      maxTimeoutSeconds: 120,
      extra: {
        assetTransferMethod: "transfer-factory" as const,
        feePayer: FACILITATOR,
        synchronizerId: SYNC,
        instrumentId: { admin: "DSO::1220", id: "Amulet" },
        executeBeforeSeconds: 120,
      },
    };
  }

  it("delegates to signTransferFactory and builds the {payer, submissionRef, preparedTxHash} payload", async () => {
    const sign = vi.fn().mockResolvedValue({
      payerParty: PAYER,
      submissionRef: "REF-123",
      preparedTxHash: "aabb",
    });
    const scheme = new ExactCantonScheme({
      party: PAYER,
      signTransferFactory: sign,
    } as unknown as CantonSigner);
    const env = await scheme.createPaymentPayload(tfRequirements(), {
      url: "https://api.example.com/x",
    });
    expect(env.payload).toEqual({
      assetTransferMethod: "transfer-factory",
      payer: PAYER,
      submissionRef: "REF-123",
      preparedTxHash: "aabb",
    });
    // The signer receives the LEDGER decimal amount (atomic → decimal at the seam).
    const arg = sign.mock.calls[0]![0] as { amount: string; receiver: string };
    expect(arg.receiver).toBe(MERCHANT);
    expect(arg.amount).toBe(atomicToDecimalCC("2500000000"));
  });

  it("throws SchemeMethodMismatchError when the signer lacks signTransferFactory", async () => {
    const scheme = new ExactCantonScheme({ party: PAYER } as CantonSigner);
    await expect(
      scheme.createPaymentPayload(tfRequirements(), { url: "https://x" })
    ).rejects.toBeInstanceOf(SchemeMethodMismatchError);
  });

  it("throws SchemeMethodMismatchError (supported = (none)) when the signer implements no method", async () => {
    // A signer that implements no compatible method facing a transfer-factory
    // resource must produce a named, branchable error reporting "(none)" as what
    // it supports.
    const noneSigner: CantonSigner = { party: PAYER };
    await expect(
      new ExactCantonScheme(noneSigner).createPaymentPayload(tfRequirements(), {
        url: "https://api.example.com/data",
      })
    ).rejects.toBeInstanceOf(SchemeMethodMismatchError);
    try {
      await new ExactCantonScheme(noneSigner).createPaymentPayload(tfRequirements(), {
        url: "https://api.example.com/data",
      });
      throw new Error("expected SchemeMethodMismatchError");
    } catch (e) {
      expect((e as SchemeMethodMismatchError).required).toBe("transfer-factory");
      expect((e as SchemeMethodMismatchError).supported).toBe("(none)");
    }
  });
})
