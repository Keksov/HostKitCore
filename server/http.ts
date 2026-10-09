// GCY1.7 (план gnauralcity, GCY-D4, GCY-D29): HTTP-утилиты ответа каркаса сервера. Три функции
// переехали из `MindWaveCore/server/server.ts` (были `:222`, `:232`, `:278`) телами побайтно;
// добавлен только `export`. Хост импортирует их под ТЕМИ ЖЕ именами: замки, читающие текст
// `server.ts` (`errorResponse(400, …)` и т. п.), видят прежние литералы.
//
// Контракт ошибок — клиентский: `requestJson` (`HostKitCore/ui/shell/admin-api.ts` и клиенты модулей)
// читает `payload.error`. Текст «Invalid JSON body» сверяют хосты (`mapProjectStoreError` в
// MindWave отвечает на него 400) — менять его нельзя.

export const jsonResponse = (aData: unknown, aStatus = 200): Response => {
  return new Response(JSON.stringify(aData), {
    status: aStatus,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  })
}

export const errorResponse = (aStatus: number, aMessage: string): Response => {
  return jsonResponse({ error: aMessage }, aStatus)
}

export const parseJsonBody = async (aRequest: Request): Promise<unknown> => {
  try {
    return await aRequest.json()
  } catch (error) {
    throw new Error("Invalid JSON body", {
      cause: error instanceof Error ? error : undefined,
    })
  }
}
