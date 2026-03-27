// stripe-webhook.js
// Uses @netlify/identity for admin user management (official Netlify approach)
// and GoTrue directly at the site's identity URL for webhook contexts

const crypto = require('crypto');

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const PRICE_FCC = process.env.STRIPE_PRICE_FCC;
const PRICE_CENTER = process.env.STRIPE_PRICE_CENTER;

// The site URL is automatically available as process.env.URL in Netlify functions
// Identity admin endpoint is at <site-url>/.netlify/identity
// We use the Netlify personal access token to authenticate as admin

const NETLIFY_ACCESS_TOKEN = process.env.NETLIFY_ACCESS_TOKEN;
const SITE_URL = process.env.URL; // e.g. https://rebloomcurriculum.com

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

async function stripeFetch(path) {
  const res = await fetch('https://api.stripe.com/v1' + path, {
    headers: { 'Authorization': 'Bearer ' + STRIPE_SECRET_KEY }
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Stripe error: ' + JSON.stringify(data));
  return data;
}

// GoTrue admin API - called directly on the site's identity endpoint
// Authenticate with Netlify personal access token
async function goTrue(method, path, body) {
  const url = SITE_URL + '/.netlify/identity' + path;
  const options = {
    method: method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + NETLIFY_ACCESS_TOKEN
    }
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  const text = await res.text();
  console.log(method, path, '->', res.status, text.substring(0, 200));
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: text }; }
}

async function inviteUser(email, plan) {
  // Use /invite endpoint which sends an invitation email automatically
  // This works with Invite Only registration setting
  const result = await goTrue('POST', '/invite', {
    email: email,
    data: { plan: plan, roles: [plan] }
  });
  console.log('Invite result:', result.status);
  return result;
}

async function findUser(email) {
  const result = await goTrue('GET', '/admin/users?per_page=100');
  if (result.data && result.data.users) {
    return result.data.users.find(u => u.email === email) || null;
  }
  return null;
}

async function updateUser(userId, plan) {
  return await goTrue('PUT', '/admin/users/' + userId, {
    app_metadata: { plan: plan, roles: [plan] }
  });
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
  try { stripeEvent = JSON.parse(rawBody); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  console.log('Event:', stripeEvent.type);
  console.log('Site URL:', SITE_URL);

  try {
    const obj = stripeEvent.data.object;

    if (stripeEvent.type === 'checkout.session.completed') {
      const email = obj.customer_details && obj.customer_details.email;
      console.log('Email:', email);

      let plan = 'center';
      if (obj.subscription) {
        const sub = await stripeFetch('/subscriptions/' + obj.subscription);
        const priceId = sub.items && sub.items.data[0] ? sub.items.data[0].price.id : null;
        console.log('Price:', priceId, 'FCC:', PRICE_FCC);
        if (priceId === PRICE_FCC) plan = 'fcc';
      }
      console.log('Plan:', plan);

      if (email) {
        // Check if user already exists
        const existing = await findUser(email);
        if (existing) {
          console.log('Updating existing user:', existing.id);
          await updateUser(existing.id, plan);
        } else {
          console.log('Inviting new user');
          await inviteUser(email, plan);
        }
      }
    }

    if (stripeEvent.type === 'customer.subscription.deleted') {
      const customer = await stripeFetch('/customers/' + obj.customer);
      if (customer.email) {
        const existing = await findUser(customer.email);
        if (existing) await updateUser(existing.id, null);
      }
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };

  } catch (err) {
    console.error('Error:', err.message);
    return { statusCode: 500, body: 'Server error: ' + err.message };
  }
};
