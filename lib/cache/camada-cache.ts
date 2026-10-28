import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import { logger } from "@/lib/logger";
import { validarConfigRedisRest } from "@/lib/redis-config";

/**
 * Camada de Cache de Alta Performance (Dois Níveis: L1 Memória Local + L2 Redis).
 *
 * ─── Contexto & Por que existe ──────────────────────────────────────────────
 * Numa arquitetura onde o banco de dados (Supabase) está no Brasil (SP) e o
 * servidor de aplicação (VPS) está na Europa, a latência de ida e volta (RTT)
 * é de ~200ms por consulta.
 *
 * Cada carregamento de página e cada chamada de API executava sequencialmente:
 * - Validação de JWT / Sessão via GoTrue (200ms)
 * - Consulta de platform_admins e user_organizations (200ms)
 * - Resolução de contexto de suporte (200ms)
 * - Resolução de role e MFA via fn_user_role_in_org (200ms - 400ms)
 *
 * Multiplicado por várias chamadas paralelas do frontend (radar, counts, etc.),
 * a tela demorava de 3 a 5 segundos de skeleton.
 *
 * Com esta camada:
 * - L1 (Memória local do processo): resposta em < 0.01ms.
 * - L2 (Redis no Docker da VPS): resposta em < 1ms.
 * - Total de RTTs transatlânticos para requisições repetidas: 0ms.
 *
 * ─── Resiliência & Fail-Open ────────────────────────────────────────────────
 * Se o Redis estiver indisponível ou lento, o cache NUNCA trava a requisição:
 * degrada silenciosamente para L1 ou para o cálculo direto no banco.
 */

interface CacheEntry<T> {
  valor: T;
  expiraEm: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __atendeai_l1_cache: Map<string, CacheEntry<unknown>> | undefined;
}

const L1_MAX_ITEMS = 2000;

function obterL1Map(): Map<string, CacheEntry<unknown>> {
  if (!globalThis.__atendeai_l1_cache) {
    globalThis.__atendeai_l1_cache = new Map();
  }
  return globalThis.__atendeai_l1_cache;
}

let _redisInstance: Redis | null | "nao_configurado" = null;
let _avisoRedisEmitido = false;

function obterClienteRedis(): Redis | null {
  if (process.env.NODE_ENV === "test") return null;
  if (_redisInstance === "nao_configurado") return null;
  if (_redisInstance) return _redisInstance;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const config = validarConfigRedisRest(url, token);

  if (!config.ok || !url || !token) {
    if (!_avisoRedisEmitido) {
      logger.info("[cache] Redis L2 desativado ou não configurado — operando em modo L1 (memória)");
      _avisoRedisEmitido = true;
    }
    _redisInstance = "nao_configurado";
    return null;
  }

  try {
    _redisInstance = new Redis({
      url,
      token,
      retry: false, // falha rápida para não bloquear requisições
    });
    return _redisInstance;
  } catch (erro) {
    logger.warn("[cache] Falha ao inicializar cliente Redis:", { erro });
    _redisInstance = "nao_configurado";
    return null;
  }
}

/**
 * Cria hash SHA-256 curto e seguro para chaves de cache baseadas em tokens ou sessões.
 */
export function hashSessao(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

/**
 * Busca no cache L1 ou L2; se não encontrar, executa a função computar(),
 * salva nos dois níveis e devolve o resultado.
 *
 * @param chave Chave única (deve conter organização/usuário quando relevante para multi-tenancy)
 * @param ttlSegundos Tempo de vida em segundos
 * @param computar Função assíncrona para buscar o dado original
 */
export async function obterOuComputar<T>(
  chave: string,
  ttlSegundos: number,
  computar: () => Promise<T>,
): Promise<T> {
  const agora = Date.now();
  const l1 = obterL1Map();

  // 1. Verificação L1 (Memória Local - < 0.01ms)
  const itemL1 = l1.get(chave) as CacheEntry<T> | undefined;
  if (itemL1 && itemL1.expiraEm > agora) {
    return itemL1.valor;
  }

  // 2. Verificação L2 (Redis Local - < 1ms)
  const redis = obterClienteRedis();
  if (redis) {
    try {
      // Timeout de segurança no Redis para evitar hang se a rede local oscilar
      const promessaRedis = redis.get<T>(chave);
      const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 150));
      const valorRedis = await Promise.race([promessaRedis, timeoutPromise]);

      if (valorRedis !== null && valorRedis !== undefined) {
        // Alimenta L1 e retorna
        l1.set(chave, {
          valor: valorRedis,
          expiraEm: agora + ttlSegundos * 1000,
        });
        return valorRedis;
      }
    } catch {
      // Falha no Redis é absorvida sem quebrar o fluxo
    }
  }

  // 3. Cache Miss: Computar dado original
  const resultado = await computar();

  // 4. Salva em L1 (com limite de tamanho)
  if (l1.size >= L1_MAX_ITEMS) {
    // Limpeza de itens expirados
    for (const [k, v] of l1.entries()) {
      if (v.expiraEm <= agora) {
        l1.delete(k);
      }
    }
    // Se ainda estiver cheio, remove os mais antigos
    if (l1.size >= L1_MAX_ITEMS) {
      const primeiro = l1.keys().next().value;
      if (primeiro) l1.delete(primeiro);
    }
  }

  l1.set(chave, {
    valor: resultado,
    expiraEm: agora + ttlSegundos * 1000,
  });

  // 5. Salva em L2 (Redis) em background
  if (redis && resultado !== undefined && resultado !== null) {
    try {
      void redis.set(chave, resultado, { ex: ttlSegundos }).catch(() => {
        // Silencioso em caso de falha de escrita no Redis
      });
    } catch {
      // Silencioso
    }
  }

  return resultado;
}

/**
 * Invalida uma chave nos caches L1 e L2.
 */
export async function invalidarCache(chave: string): Promise<void> {
  const l1 = obterL1Map();
  l1.delete(chave);

  const redis = obterClienteRedis();
  if (redis) {
    try {
      await redis.del(chave);
    } catch {
      // Silencioso
    }
  }
}

/**
 * Limpa todo o cache L1 da memória local do processo.
 */
export function limparCacheLocal(): void {
  const l1 = obterL1Map();
  l1.clear();
}
