import { handleCancelOrder } from "../_shared/handlers.ts";
import { denoDeps } from "../_shared/deno-deps.ts";

declare const Deno: { serve(handler: (req: Request) => Response | Promise<Response>): unknown };

const deps = denoDeps("mp-cancel-order");
Deno.serve((req) => handleCancelOrder(req, deps));
