import { handleCreateClaim } from "../_shared/whatsapp-handlers.ts";
import { denoDeps } from "../_shared/deno-deps.ts";

declare const Deno: { serve(handler: (req: Request) => Response | Promise<Response>): unknown };

const deps = denoDeps("whatsapp-create-claim");
Deno.serve((req) => handleCreateClaim(req, deps));
