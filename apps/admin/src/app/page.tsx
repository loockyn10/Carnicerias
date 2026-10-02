import { redirect } from "next/navigation";

import { getCurrentUser } from "../lib/supabase/current-user";
import { createClient } from "../lib/supabase/server";

export default async function HomePage() {
  const supabase = await createClient();
  const user = await getCurrentUser(supabase);

  redirect(user ? "/admin" : "/login");
}

