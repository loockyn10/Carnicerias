import { handleSendTicket } from "../_shared/whatsapp-handlers.ts";
import { denoDeps } from "../_shared/deno-deps.ts";

declare const Deno: { serve(handler: (req: Request) => Response | Promise<Response>): unknown };

const deps = denoDeps("whatsapp-send-ticket");
Deno.serve((req) => handleSendTicket(req, deps));
