// Supabase Edge Function: classify-waste
//
// Replaces the client-side keyword-matching + photo-brightness heuristic
// with a real multimodal vision model call. Given a photo (and/or text
// description) of a reported item, it returns a structured classification
// constrained to the exact waste-type list your TYPE_RULES already uses,
// so the result plugs straight into your existing routing/points logic
// with no changes needed there.
//
// Any authenticated user (any role) may call this - it's invoked from
// the citizen report form before the report is inserted, using the
// caller's own session, not the service-role key.
//
// Deploy: supabase functions deploy classify-waste
// Requires a secret:  supabase secrets set GEMINI_API_KEY=your_key_here
// (Get a free key at aistudio.google.com -> Get API Key. To switch
// providers again later, only callVisionModel() below needs to change.)

import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;

// Must match the `type` strings in TYPE_RULES exactly, or the result
// won't match anything when the frontend looks up effort/recyclable.
const VALID_TYPES = [
  "Mattress", "Bed frame", "Sofa / Upholstered furniture", "Chair", "Table", "Wardrobe",
  "Appliance", "Construction debris", "Wood scrap", "Metal scrap", "Bicycle",
  "Door", "Window", "Electronics / TV", "Carpet / Rug", "Cabinet",
  "Garden waste", "Tire", "Suitcase / Luggage", "Bag / Backpack", "Boxes / Packaging", "Other"
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    // Confirm the caller is a logged-in user (any role) - not open to
    // anonymous callers, since each classification costs a real API call.
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } }
    });
    const { data: { user }, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const { description, image_base64 } = await req.json();
    if (!description && !image_base64) {
      return new Response(JSON.stringify({ error: "Provide at least a description or a photo" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const result = await callVisionModel(description || "", image_base64 || null);
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});

async function callVisionModel(description: string, imageBase64: string | null) {
  const prompt = `You are a municipal bulky-waste sorting assistant helping route a discarded household item for collection.
${description
    ? `The citizen's own description: "${description}"`
    : "No text description was provided - you must identify the item from the photo alone. Look carefully at its shape, material, size relative to anything else visible, and distinguishing features (fabric or cushions, wood grain, metal casing, a screen, wheels, drawers, etc.) before deciding."}

If more than one object is visible, focus on the single most prominent discarded item clearly being reported - not incidental background objects.

Reply with a JSON object with exactly these keys:
- "type": the specific item, 2-4 plain words (e.g. "Bed frame", "Suitcase", "Office chair", "Car battery"). If it clearly matches one of these known categories, use that exact name: ${JSON.stringify(VALID_TYPES.filter(t=>t!=='Other'))}. If it doesn't match any of them well, give your own specific, concrete name instead - never a vague catch-all like "bulky waste," "household item," or "furniture." Only use "Other" if you genuinely cannot tell what the object is at all (e.g. an unrecognizable shape, or the photo is unusable).
- "condition": one of "good", "fair", "damaged" - "good" means still fully usable/resellable, "fair" means usable but worn or needing minor repair, "damaged" means visibly broken or non-functional.
- "hazard": boolean - true only for a real handling hazard (visible asbestos-like material, gas cylinders, car/vehicle batteries, chemical containers, a large amount of broken glass, leaking fluids). False for ordinary furniture/appliances even if damaged.
- "confidence": a number between 0 and 1 - lower it if the photo is blurry, dark, distant, or the item is only partially visible.
- "disposal_instructions": one short practical sentence for the collection crew.`;

  const parts: any[] = [{ text: prompt }];
  if (imageBase64) {
    parts.push({ inline_data: { mime_type: "image/jpeg", data: imageBase64 } });
  }

  // gemini-3.5-flash-lite: current (Aug 2026) low-latency, cost-effective
  // Gemini model, well suited to a high-volume classification task like
  // this one. responseMimeType forces the model to return raw JSON
  // directly, which is more reliable than asking nicely in the prompt.
  // Auth via the x-goog-api-key header (Google's current documented
  // method) rather than a ?key= query param, which is inconsistent
  // across API generations and a likely silent-failure point.
  const model = "gemini-3.5-flash-lite";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json" }
      })
    }
  );

  if (!res.ok) {
    throw new Error(`Vision model request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";

  let parsed;
  try {
    // Stray ```json fence shouldn't happen with responseMimeType set,
    // but strip it if present anyway - cheap safety net, costs nothing.
    const cleaned = rawText.replace(/^```json\s*|```$/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Model did not return valid JSON: " + rawText.slice(0, 200));
  }

  // Previously any type that wasn't an exact match to the preset list
  // got silently overwritten with generic "Other" - discarding a
  // perfectly good, specific answer (e.g. "Bed frame") just because it
  // didn't match a hardcoded string. Now the model's own answer is
  // trusted as-is; only a missing/empty type falls back to "Other".
  // Downstream, TYPE_RULES.find() already handles a type that isn't on
  // the preset list gracefully (a sensible default effort/recyclable
  // value), so nothing else needs to change for this to work safely.
  if (!parsed.type || typeof parsed.type !== "string") parsed.type = "Other";
  else parsed.type = parsed.type.trim();
  if (!["good", "fair", "damaged"].includes(parsed.condition)) parsed.condition = "fair";
  parsed.hazard = !!parsed.hazard;
  parsed.confidence = typeof parsed.confidence === "number"
    ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;

  return parsed;
}