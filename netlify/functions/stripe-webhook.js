// stripe-webhook.js
// Handles Stripe subscription events and manages Supabase users

const crypto = require('crypto');

// Verify Stripe webhook signature
function verifyStripeSignature(payload, signature, secret) {
  const parts = signature.split(',');
  const timestamp = parts.find(p => p.startsWith('t=')).split('=')[1];
  const signatures = parts.filter(p => p.startsWith('v1=')).map(p => p.split('=')[1]);
  const signedPayload = `${timestamp}.${payload}`;
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');
  return signatures.some(sig => crypto.timingSafeEqual(
    Buffer.from(sig, 'hex'),
    Buffer.from(expectedSig, 'hex')
  ));
}

// Determine plan from Stripe price ID
function getPlanFromPriceId(priceId) {
  if (priceId === process.env.STRIPE_PRICE_CENTER) return 'center';
  if (priceId === process.env.STRIPE_PRICE_FCC) return 'fcc';
  return 'unknown';
}

// Supabase admin API call
async function supabaseAdmin(method, path, body) {
  const url = `${process.env.SUPABASE_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Prefer': method === 'POST' ? 'return=representation' : ''
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: text }; }
}

// Create Supabase auth user and send invite email
async function createSupabaseUser(email, plan, stripeCustomerId, stripeSubscriptionId) {
  // Create auth user via admin API
  const authRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
    },
    body: JSON.stringify({
      email,
      email_confirm: false,
      send_confirmation_email: false, // invite email sent separately below
      user_metadata: { plan }
    })
  });

  const authData = await authRes.json();
  console.log('Auth user created:', authRes.status, authData.id || authData.error);

  let userId = authData.id;

  if (!authRes.ok) {
    // User already exists — look up their existing ID so we can still send the invite
    if (authData.msg?.includes('already been registered') || authData.code === 'email_exists') {
      console.log('User already exists, looking up existing ID for:', email);
      const listRes = await fetch(
        `${process.env.SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
        {
          headers: {
            'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
          }
        }
      );
      const listData = await listRes.json();
      userId = listData.users?.[0]?.id;
      console.log('Existing user ID found:', userId);
    } else {
      throw new Error(`Auth user creation failed: ${JSON.stringify(authData)}`);
    }
  }

  // Send invite email — with error logging so failures are visible
  if (userId) {
    const inviteRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}/send-invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
    const inviteData = await inviteRes.json();
    if (!inviteRes.ok) {
      console.error('Invite email failed:', JSON.stringify(inviteData));
    } else {
      console.log('Invite email sent successfully to:', email);
    }
  } else {
    console.error('Could not determine user ID — invite email not sent for:', email);
  }

  // Upsert into subscribers table
  await supabaseAdmin('POST', '/subscribers?on_conflict=email', {
    email,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubscriptionId,
    plan,
    status: 'active'
  });

  console.log('Subscriber record upserted for:', email);
}

// Update subscriber status
async function updateSubscriberStatus(stripeSubscriptionId, status) {
  await supabaseAdmin(
    'PATCH',
    `/subscribers?stripe_subscription_id=eq.${stripeSubscriptionId}`,
    { status }
  );
  console.log('Subscriber status updated:', stripeSubscriptionId, status);
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const sig = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // Verify signature
  try {
    if (!verifyStripeSignature(event.body, sig, webhookSecret)) {
      console.error('Invalid Stripe signature');
      return { statusCode: 400, body: 'Invalid signature' };
    }
  } catch (err) {
    console.error('Signature verification error:', err.message);
    return { statusCode: 400, body: 'Signature error' };
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  console.log('Stripe event received:', stripeEvent.type);

  try {
    switch (stripeEvent.type) {

      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const email = session.customer_details?.email || session.customer_email;
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        if (!email || !subscriptionId) {
          console.log('Missing email or subscription ID, skipping');
          break;
        }

        // Get subscription to find price ID and plan
        const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
          headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` }
        });
        const sub = await subRes.json();
        const priceId = sub.items?.data?.[0]?.price?.id;
        const plan = getPlanFromPriceId(priceId);

        console.log('New subscriber:', email, 'plan:', plan);
        await createSupabaseUser(email, plan, customerId, subscriptionId);
        break;
      }

      case 'customer.subscription.deleted':
      case 'customer.subscription.paused': {
        const sub = stripeEvent.data.object;
        await updateSubscriberStatus(sub.id, 'canceled');
        break;
      }

      case 'customer.subscription.updated': {
        const sub = stripeEvent.data.object;
        const status = sub.status === 'active' ? 'active' : sub.status;
        await updateSubscriberStatus(sub.id, status);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object;
        if (invoice.subscription) {
          await updateSubscriberStatus(invoice.subscription, 'past_due');
        }
        break;
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    // Still return 200 to Stripe so it doesn't retry
    return { statusCode: 200, body: JSON.stringify({ received: true, error: err.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
