import { describe, expect, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    channel: () => ({ httpSend: async () => { throw new Error("realtime down"); } }),
    removeChannel: async () => { throw new Error("cleanup failed"); },
  }),
}));

describe("publish", () => {
  it("never throws after the write was committed", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    const { publish } = await import("@/lib/realtime");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(publish([{ type: "alerta.creada", sucursal_id: "S1", data: {} }])).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
