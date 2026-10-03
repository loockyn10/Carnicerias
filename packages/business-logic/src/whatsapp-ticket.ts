// Fuente única en `supabase/functions/_shared/whatsapp-ticket.ts` (teléfono, elegibilidad, modelo y texto
// del ticket): las Edge Functions (Deno) sólo pueden importar desde `supabase/functions`, y el POS/los
// tests desde acá. Sin duplicar lógica.
export * from "../../../supabase/functions/_shared/whatsapp-ticket";
