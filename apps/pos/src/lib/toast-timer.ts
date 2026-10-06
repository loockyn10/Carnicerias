/** Cuánto dura el aviso de "Venta completada" antes de irse solo. */
export const POST_SALE_TOAST_MS = 5_000;

/**
 * Programa el cierre automático de un aviso. Devuelve la función que lo cancela: el efecto de React la usa como
 * cleanup, así que un aviso nuevo (o desmontar el componente) nunca deja un temporizador viejo vivo.
 */
export function scheduleToastDismiss(onDismiss: () => void, delayMs: number = POST_SALE_TOAST_MS): () => void {
  const handle = setTimeout(onDismiss, delayMs);
  return () => clearTimeout(handle);
}
