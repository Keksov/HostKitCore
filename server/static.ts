// GCY1.7 (план gnauralcity, GCY-D29): статика каркаса — собранный UI хоста из его каталога. Таблица
// типов и `serveStatic` переехали из `MindWaveCore/server/server.ts` (были `:2744` и `:2751`) телами
// побайтно; каталог `publicDir`, бывший глобалом хоста, приходит параметром фабрики. Поведение
// прежнее: `/` → `/index.html`, выход за каталог — 403 текстом, нет файла — 404 текстом, без
// SPA-фолбэка (маршрутизатор UI — хэш), `cache-control: no-store`.

import { extname, isAbsolute, relative, resolve } from "node:path"

const mimeByExtension: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
}

/**
 * Обработчик статики из `publicDir` (абсолютный путь): путь запроса → ответ. Имя параметра — без
 * обычного префикса `a`: тело перенесено побайтно (со сдвигом отступа), и в нём глобал хоста звался так.
 */
export const createStaticHandler = (publicDir: string): ((aPathname: string) => Promise<Response>) => {
  const serveStatic = async (aPathname: string): Promise<Response> => {
    const normalizedPath = aPathname === "/" ? "/index.html" : aPathname
    const filePath = resolve(publicDir, `.${normalizedPath}`)
    const relativePath = relative(publicDir, filePath)

    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      return new Response("Forbidden", { status: 403 })
    }

    const file = Bun.file(filePath)

    if (!(await file.exists())) {
      return new Response("Not found", { status: 404 })
    }

    const extension = extname(filePath).toLowerCase()
    const mime = mimeByExtension[extension] ?? "application/octet-stream"

    return new Response(file, {
      headers: {
        "content-type": mime,
        "cache-control": "no-store"
      }
    })
  }

  return serveStatic
}
