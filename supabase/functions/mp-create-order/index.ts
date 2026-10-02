import { handleCreateOrder } from "../_shared/handlers.ts";
import { denoDeps } from "../_shared/deno-deps.ts";

declare const Deno: { serve(handler: (req: Request) => Response | Promise<Response>): unknown };

const deps = denoDeps("mp-create-order");
Deno.serve((req) => handleCreateOrder(req, deps));
