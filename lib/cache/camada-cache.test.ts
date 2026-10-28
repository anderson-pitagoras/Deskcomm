import { describe, expect, it, vi } from "vitest";
import { hashSessao, invalidarCache, obterOuComputar } from "./camada-cache";

describe("camada-cache (L1 / L2)", () => {
  it("gera hash seguro de sessão com 32 caracteres hex", () => {
    const hash1 = hashSessao("token-secreto-12345");
    const hash2 = hashSessao("token-secreto-12345");
    const hash3 = hashSessao("outro-token-67890");

    expect(hash1).toHaveLength(32);
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
  });

  it("busca e armazena em cache na primeira chamada e reutiliza na segunda", async () => {
    const fnComputar = vi.fn(async () => ({ user_id: "u-123", email: "teste@empresa.com" }));
    const chave = "teste:user:123";

    // 1ª chamada: executa a função
    const r1 = await obterOuComputar(chave, 10, fnComputar);
    expect(r1).toEqual({ user_id: "u-123", email: "teste@empresa.com" });
    expect(fnComputar).toHaveBeenCalledTimes(1);

    // 2ª chamada: serve do cache L1 sem chamar fnComputar novamente
    const r2 = await obterOuComputar(chave, 10, fnComputar);
    expect(r2).toEqual({ user_id: "u-123", email: "teste@empresa.com" });
    expect(fnComputar).toHaveBeenCalledTimes(1);
  });

  it("invalida a chave e recalcula na próxima chamada", async () => {
    let contador = 0;
    const fnComputar = vi.fn(async () => ({ contador: ++contador }));
    const chave = "teste:contador:abc";

    const r1 = await obterOuComputar(chave, 10, fnComputar);
    expect(r1.contador).toBe(1);

    await invalidarCache(chave);

    const r2 = await obterOuComputar(chave, 10, fnComputar);
    expect(r2.contador).toBe(2);
    expect(fnComputar).toHaveBeenCalledTimes(2);
  });
});
