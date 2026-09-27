import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  try {
    const authHeader = req.headers.get('Authorization') || ''
    const jwt = authHeader.replace('Bearer ', '')

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Confirm the caller is actually a logged-in admin before doing
    // anything - without this check, anyone who finds this function's
    // URL could create or delete accounts.
    const { data: { user: caller }, error: callerErr } = await supabaseAdmin.auth.getUser(jwt)
    if (callerErr || !caller) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    const { data: callerProfile } = await supabaseAdmin.from('profiles').select('role, active').eq('id', caller.id).single()
    if (!callerProfile || callerProfile.role !== 'admin' || !callerProfile.active) {
      return new Response(JSON.stringify({ error: 'Admin only' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const payload = await req.json()
    // Accept 'action' or 'type', and treat 'invite' as 'create'
    const action = (payload.action || payload.type || '').toLowerCase()
    const { name, email, password, userId, role } = payload

    if (action === 'create' || action === 'invite') {
      const generatedPassword = password || Math.random().toString(36).slice(-10) + '!A1'

      const { data, error } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: generatedPassword,
        email_confirm: true,
        // invited_by_admin marks this account as admin-provisioned, so the
        // database trigger activates it immediately - self-signups from
        // the public form (recycler/repairer) don't get this flag and
        // stay pending until an admin approves them from the Users tab.
        // display_name was previously missing here entirely, so the
        // database trigger always fell back to using the email address
        // as the name - which is exactly what was showing up on the
        // Leaderboard instead of the name the admin actually typed in.
        user_metadata: { role, invited_by_admin: true, display_name: name || email }
      })
      if (error) throw error
      return new Response(JSON.stringify({ ...data, generatedPassword: password ? undefined : generatedPassword }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (action === 'delete' || action === 'remove') {
      const { data, error } = await supabaseAdmin.auth.admin.deleteUser(userId)
      if (error) throw error
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ error: `Invalid action: received '${payload.action}'` }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
