// Dependencias reales de las Edge Functions (Deno). Es el único archivo que toca `Deno`;
// los handlers reciben estas dependencias por parámetro (ver handlers.ts) para poder probarse.
import type { HandlerDeps } from "./handlers.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

export function denoDeps(functionName: string): HandlerDeps {
  return {
    env: (name) => Deno.env.get(name),
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    // Nunca se loguean secretos, cuerpos de request ni tokens: sólo mensajes y metadata mínima.
    log: (message, extra) => { console.log(JSON.stringify({ fn: functionName, message, ...extra })); }
  };
}
