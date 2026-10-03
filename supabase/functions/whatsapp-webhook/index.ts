import { handleWhatsAppWebhook } from "../_shared/whatsapp-handlers.ts";
import { denoDeps } from "../_shared/deno-deps.ts";

declare const Deno: { serve(handler: (req: Request) => Response | Promise<Response>): unknown };

const deps = denoDeps("whatsapp-webhook");
Deno.serve((req) => handleWhatsAppWebhook(req, deps));
