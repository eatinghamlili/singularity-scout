// Retired. This used to write AI overviews of a team's scouting with the team's Anthropic key.
// The AI overview is switched off on the board, and an open endpoint that spends a paid key
// (and saves to the database without a scout sign-in) isn't worth keeping around, so it now
// answers every request with "gone" and does nothing else.
// To bring the feature back, restore this file from git history and require a scout token first.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  return new Response(JSON.stringify({ error: "retired", message: "The AI overview is switched off." }), {
    status: 410, headers: { ...CORS, "Content-Type": "application/json" },
  });
});
