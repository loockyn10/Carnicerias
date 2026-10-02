import { handleWebhook } from "../_shared/handlers.ts";
import { denoDeps } from "../_shared/deno-deps.ts";

declare const Deno: { serve(handler: (req: Request) => Response | Promise<Response>): unknown };

const deps = denoDeps("mp-webhook");
Deno.serve((req) => handleWebhook(req, deps));
