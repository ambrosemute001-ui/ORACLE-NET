// Supabase Edge Function: notify-report-event
//
// Triggered by a Database Webhook on the "reports" table (INSERT and
// UPDATE). Sends email notifications via Resend:
//   - New report filed              -> every active Municipal Admin
//   - Report marked collected       -> the citizen who filed it
//   - Report routed to recycle      -> every active Recycler Cooperative account
//   - Report routed to repair       -> every active Repairer account
//   - Report routed to sell/reuse   -> every active citizen (new marketplace/donation listing)
//
// REQUIRES: `alter table public.reports replica identity full;` (see
// supabase-migration-replica-identity.sql) - without it, old_record on
// UPDATE events won't reliably contain the previous status/route, and
// the "just changed" comparisons below will misfire or miss events.
//
// Deploy: supabase functions deploy notify-report-event
// Requires a RESEND_API_KEY secret: supabase secrets set RESEND_API_KEY=re_xxx
// (Resend's free tier works with no domain setup if you send FROM
// "onboarding@resend.dev" - fine for testing; switch to your own
// verified domain before relying on this for real operations.)

import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM_EMAIL = Deno.env.get("NOTIFY_FROM_EMAIL") || "Oracle Net <onboarding@resend.dev>";
const APP_URL = Deno.env.get("APP_URL") || ""; // e.g. https://your-site.netlify.app - included in emails as a link back in

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function sendEmail(to: string[], subject: string, html: string){
  if(!to.length) return;
  try{
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html })
    });
    if(!res.ok){
      // Previously the response was never checked at all, so every
      // failure here (bad API key, unverified sender restrictions,
      // invalid recipient) was completely invisible - the webhook would
      // report success even though no email ever went out. Now it shows
      // up in `supabase functions logs notify-report-event`.
      const body = await res.text().catch(()=> '');
      console.error(`sendEmail failed (${res.status}) to [${to.join(', ')}]: ${body}`);
    }
  } catch(err){
    console.error(`sendEmail threw for [${to.join(', ')}]:`, err);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const payload = await req.json(); // { type: 'INSERT'|'UPDATE', table, record, old_record }
    const { type, record, old_record } = payload;
    const link = APP_URL ? `<p><a href="${APP_URL}">Open Oracle Net</a></p>` : "";

    async function emailsForRole(role: string){
      const { data } = await admin.from('profiles').select('email').eq('role', role).eq('active', true);
      return (data || []).map((p: any) => p.email);
    }
    async function emailForUser(userId: string | null){
      if(!userId) return null;
      const { data } = await admin.from('profiles').select('email').eq('id', userId).single();
      return data?.email || null;
    }

    // ---------- New report filed ----------
    if(type === 'INSERT'){
      const admins = await emailsForRole('admin');
      await sendEmail(admins,
        `New report filed: ${record.type} in ${record.locality}`,
        `<p>A new report was filed.</p>
         <p><b>Type:</b> ${record.type}<br><b>Locality:</b> ${record.locality}<br><b>Condition:</b> ${record.condition}<br><b>Reported by:</b> ${record.citizen}</p>
         ${link}`
      );
      return new Response(JSON.stringify({ ok: true, notified: 'admins' }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // ---------- Existing report updated ----------
    if(type === 'UPDATE'){
      const justCollected = old_record.status !== 'collected' && record.status === 'collected';
      const routeChanged = old_record.route !== record.route && record.route;

      if(justCollected){
        const reporterEmail = await emailForUser(record.reported_by);
        if(reporterEmail){
          await sendEmail([reporterEmail],
            `Your report #ORC-${record.id} was collected`,
            `<p>Your report (${record.type}, ${record.locality}) has been collected and routed to <b>${record.route}</b>.</p>${link}`
          );
        }
      }

      if(justCollected || routeChanged){
        if(record.route === 'recycle'){
          const recyclers = await emailsForRole('recycler');
          await sendEmail(recyclers, `New pickup available: #ORC-${record.id}`,
            `<p>A ${record.type} in ${record.locality} is ready for recycler pickup.</p>${link}`);
        }
        if(record.route === 'repair'){
          const repairers = await emailsForRole('repairer');
          await sendEmail(repairers, `New item awaiting repair: #ORC-${record.id}`,
            `<p>A ${record.type} in ${record.locality} is ready to be picked up for repair.</p>${link}`);
        }
        // "sell": routed straight to the marketplace at good condition.
        // "reuse": a free donation. Both go to every active citizen -
        // for a small community this is the right reach; if your citizen
        // list grows large, consider this a candidate to scale back to
        // a daily digest instead of one email per listing.
        if(record.route === 'sell'){
          const citizens = await emailsForRole('citizen');
          await sendEmail(citizens, `New item for sale: #ORC-${record.id}`,
            `<p>A ${record.type} in ${record.locality} was just listed for sale${record.price ? ` at ${record.price}` : ''} on the Marketplace.</p>${link}`);
        }
        if(record.route === 'reuse'){
          const citizens = await emailsForRole('citizen');
          await sendEmail(citizens, `New free item available: #ORC-${record.id}`,
            `<p>A ${record.type} in ${record.locality} is available to claim for free.</p>${link}`);
        }
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ ok: true, skipped: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
