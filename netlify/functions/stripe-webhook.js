// stripe-webhook.js
// Uses Netlify API (api.netlify.com) with personal access token to create Identity users
// This is the correct approach when calling from a webhook (no clientContext available)

const crypto = require('crypto');

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const PRICE_FCC = process.env.STRIPE_PRICE_FCC;
const PRICE_CENTER = process.env.STRIPE_PRICE_CENTER;
const NETLIFY_ACCESS_TOKEN = process.env.NETLIFY_ACCESS_TOKEN; // Your personal access token
const NETLIFY_SITE_ID = process.env.NETLIFY_SITE_ID; // Your site ID

// Verify Stripe webhook signature
function verifyStripeSignature(rawBody, sigHeader, secret) {
  const parts = sigHeader.split(',');
  let timestamp = '';
  const signatures = [];
  for (const part of parts) {
    const [key, val] = part.split('=');
    if (key === 't') timestamp = val;
    if (key === 'v1') signatures.push(val);
  }
  if (!timestamp || signatures.length === 0) return false;
  const payload = timestamp + '.' + rawBody;
  const expected = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  return signatures.some(sig => {
    try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); }
    catch { return false; }
  });
}

// Call Stripe API
async function stripeFetch(path) {
  const res = await fetch('https://api.stripe.com/v1' + path, {
    headers: { 'Authorization': 'Bearer ' + STRIPE_SECRET_KEY }
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Stripe API error: ' + JSON.stringify(data));
  return data;
}

// Call Netlify API to create an Identity user
async function createIdentityUser(email, name, plan) {
  const url = `https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/identity/users`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + NETLIFY_ACCESS_TOKEN
    },
    body: JSON.stringify({
      email: email,
      user_metadata: { full_name: name || '' },
      app_metadata: { plan: plan, roles: [plan] },
      send_invite: true  // sends the user an invitation email automatically
    })
  });
  const text = await res.text();
  console.log('Create user response:', res.status, text.substring(0, 300));
  return { status: res.status, body: text };
}

// Call Netlify API to update an existing Identity user
async function updateIdentityUser(userId, plan) {
  const url = `https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/identity/users/${userId}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + NETLIFY_ACCESS_TOKEN
    },
    body: JSON.stringify({
      app_metadata: { plan: plan, roles: [plan] }
    })
  });
  const text = await res.text();
  console.log('Update user response:', res.status, text.substring(0, 300));
  return { status: res.status, body: text };
}

// Find existing user by email via Netlify API
async function findUserByEmail(email) {
  const url = `https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/identity/users?per_page=1&email=${encodeURIComponent(email)}`;
  const res = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + NETLIFY_ACCESS_TOKEN }
  });
  const text = await res.text();
  console.log('Find user response:', res.status, text.substring(0, 300));
  try {
    const data = JSON.parse(text);
    return data.users && data.users[0] ? data.users[0] : null;
  } catch { return null; }
}

// Revoke user access on cancellation
async function revokeUser(email) {
  const user = await findUserByEmail(email);
  if (user) {
    await updateIdentityUser(user.id, null);
    console.log('Revoked user:', email);
  }
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const sig = event.headers['stripe-signature'];
  if (!sig) return { statusCode: 400, body: 'Missing stripe-signature' };

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  if (!verifyStripeSignature(rawBody, sig, STRIPE_WEBHOOK_SECRET)) {
    console.error('Signature verification failed');
    return { statusCode: 400, body: 'Invalid signature' };
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch (err) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  console.log('Event type:', stripeEvent.type);
  console.log('Site ID:', NETLIFY_SITE_ID);

  try {
    const obj = stripeEvent.data.object;

    if (stripeEvent.type === 'checkout.session.completed') {
      const email = obj.customer_details && obj.customer_details.email;
      const name  = obj.customer_details && obj.customer_details.name;
      console.log('Checkout completed for:', email);

      // Get subscription to determine plan
      let plan = 'center';
      if (obj.subscription) {
        const sub = await stripeFetch('/subscriptions/' + obj.subscription);
        const priceId = sub.items && sub.items.data && sub.items.data[0]
          ? sub.items.data[0].price.id : null;
        console.log('Price ID:', priceId, '| FCC:', PRICE_FCC, '| Center:', PRICE_CENTER);
        if (priceId === PRICE_FCC) plan = 'fcc';
      }

      console.log('Plan assigned:', plan);

      if (email) {
        // Check if user already exists
        const existing = await findUserByEmail(email);
        if (existing) {
          console.log('Updating existing user:', existing.id);
          await updateIdentityUser(existing.id, plan);
        } else {
          console.log('Creating new user with invite email');
          await createIdentityUser(email, name, plan);
        }
      }
    }

    if (stripeEvent.type === 'customer.subscription.deleted') {
      const customer = await stripeFetch('/customers/' + obj.customer);
      if (customer.email) await revokeUser(customer.email);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };

  } catch (err) {
    console.error('Handler error:', err.message, err.stack);
    return { statusCode: 500, body: 'Server error: ' + err.message };
  }
};
