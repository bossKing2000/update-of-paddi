import { scanKeys } from "../../src/lib/redisScan";

describe("scanKeys cursor behaviour", () => {
  it("terminates on an empty first scan and returns no keys", async () => {
    const scan = jest.fn(async () => ({ cursor: "0", keys: [] }));
    const keys = await scanKeys({ scan } as any, "products:*");
    expect(keys).toEqual([]);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledWith("0", { MATCH: "products:*", COUNT: 100 });
  });

  it("advances the cursor across pages until it returns to 0", async () => {
    const scan = jest.fn(async (cursor: any) => {
      if (cursor === "0") return { cursor: "17", keys: ["a", "b"] };
      return { cursor: "0", keys: ["c"] };
    });
    const keys = await scanKeys({ scan } as any, "products:*");
    expect(keys).toEqual(["a", "b", "c"]);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("propagates scan failures instead of reporting success", async () => {
    const error = new Error("redis scan failed");
    const scan = jest.fn(async () => {
      throw error;
    });
    await expect(scanKeys({ scan } as any, "products:*")).rejects.toThrow(error);
  });
});
