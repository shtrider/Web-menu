import "@supabase/functions-js/edge-runtime.d.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// The same PIN hash used in the frontend — server-side verification
const PIN_HASH = "8beedb9068239aa2e47b1d31c551e5cd5ce5fb1daad51479a136a2af677e06ed";

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { menu, specials, pinHash, unavailable_items, menu_override, action } = await req.json();

    // Verify PIN hash
    if (!pinHash || pinHash !== PIN_HASH) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Use service_role key to bypass RLS
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    let payload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (action === "save_state") {
      // Lightweight save: only operational state
      if (unavailable_items !== undefined) payload.unavailable_items = unavailable_items;
      if (menu_override !== undefined) payload.menu_override = menu_override;
    } else {
      // Full menu save
      if (!menu || typeof menu !== "object") {
        return new Response(JSON.stringify({ error: "Invalid menu data" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      payload.menu = menu;
      payload.specials = specials || {};
      if (unavailable_items !== undefined) payload.unavailable_items = unavailable_items;
      if (menu_override !== undefined) payload.menu_override = menu_override;
    }

    // Try PATCH first (update existing row)
    const patchRes = await fetch(
      `${supabaseUrl}/rest/v1/menu_data?id=eq.main`,
      {
        method: "PATCH",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify(payload),
      }
    );

    if (!patchRes.ok) {
      const err = await patchRes.json().catch(() => ({}));
      throw new Error(err.message || `PATCH failed: ${patchRes.status}`);
    }

    const patched = await patchRes.json();

    // If no rows updated, INSERT
    if (Array.isArray(patched) && patched.length === 0) {
      const postRes = await fetch(`${supabaseUrl}/rest/v1/menu_data`, {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify({ id: "main", ...payload }),
      });

      if (!postRes.ok) {
        const err = await postRes.json().catch(() => ({}));
        throw new Error(err.message || `POST failed: ${postRes.status}`);
      }
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
