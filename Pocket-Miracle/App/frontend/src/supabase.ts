import { createClient } from "@supabase/supabase-js";
import config from "./supabase-config.json";

// Publishable credentials are intentionally public. RLS authorizes every row.
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL || config.url,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || config.publishableKey,
);
