// stripe-webhook.js — no external dependencies, uses built-in crypto and fetch
const crypto = require('crypto');

const NETLIFY_IDENTITY_URL = process.env.URL + '/.netlify/identity';
const NETLIFY_IDENTITY_TOKEN = process.env.NETLIFY_IDENTITY_TOKEN;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const PRICE_FCC = process.env.STRIPE_PRICE_FCC;
const PRICE_CENTER = process.env.STRIPE_PRICE_CENTER;

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

// Call Netlify Identity API
async function netlifyFetch(path, method, body) {
  const res = await fetch(NETLIFY_IDENTITY_URL + path, {
    method: method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + NETLIFY_IDENTITY_TOKEN
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  console.log('Netlify', method || 'GET', path, res.status, text.substring(0, 200));
  try { return JSON.parse(text); } catch { return {}; }
}

async function getUserByEmail(email) {
  const data = await netlifyFetch('/admin/users?per_page=1&email=' + encodeURIComponent(email));
  return data.users && data.users[0] ? data.users[0] : null;
}

async function createOrUpdateUser(email, name, plan) {
  console.log('createOrUpdateUser:', email, plan);
  const existing = await getUserByEmail(email);
  if (existing) {
    console.log('User exists, updating plan');
    await netlifyFetch('/admin/users/' + existing.id, 'PUT', {
      app_metadata: { plan: plan, roles: [plan] }
    });
  } else {
    console.log('Creating new user');
    await netlifyFetch('/admin/users', 'POST', {
      email: email,
      password: crypto.randomBytes(16).toString('hex'),
      confirm: true,
      user_metadata: { full_name: name || '' },
      app_metadata: { plan: plan, roles: [plan] }
    });
  }
  // Send password recovery email so user can set their own password
  console.log('Sending recovery email to:', email);
  await netlifyFetch('/recover', 'POST', { email: email });
}

async function revokeUser(email) {
  const existing = await getUserByEmail(email);
  if (existing) {
    await netlifyFetch('/admin/users/' + existing.id, 'PUT', {
      app_metadata: { plan: null, roles: [] }
    });
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

  try {
    const obj = stripeEvent.data.object;

    if (stripeEvent.type === 'checkout.session.completed') {
      const email = obj.customer_details && obj.customer_details.email;
      const name  = obj.customer_details && obj.customer_details.name;
      console.log('Checkout completed for:', email);

      // Get subscription to determine price/plan
      let plan = 'center'; // default
      if (obj.subscription) {
        const sub = await stripeFetch('/subscriptions/' + obj.subscription);
        const priceId = sub.items && sub.items.data && sub.items.data[0]
          ? sub.items.data[0].price.id : null;
        console.log('Price ID from subscription:', priceId);
        console.log('FCC price env:', PRICE_FCC);
        console.log('Center price env:', PRICE_CENTER);
        if (priceId === PRICE_FCC) plan = 'fcc';
        else if (priceId === PRICE_CENTER) plan = 'center';
      }

      console.log('Assigned plan:', plan);
      if (email) await createOrUpdateUser(email, name, plan);
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
