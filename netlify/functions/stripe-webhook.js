// stripe-webhook.js
// Netlify serverless function — handles Stripe subscription events
// Creates Netlify Identity accounts when someone subscribes

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const NETLIFY_IDENTITY_URL = process.env.URL + '/.netlify/identity';
const NETLIFY_IDENTITY_TOKEN = process.env.NETLIFY_IDENTITY_TOKEN;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const PRICE_CENTER = process.env.STRIPE_PRICE_CENTER;
const PRICE_FCC = process.env.STRIPE_PRICE_FCC;

async function createOrUpdateUser(email, name, plan) {
  // Try to create user
  const res = await fetch(NETLIFY_IDENTITY_URL + '/admin/users', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + NETLIFY_IDENTITY_TOKEN
    },
    body: JSON.stringify({
      email: email,
      password: Math.random().toString(36).slice(-16),
      confirm: true,
      user_metadata: { full_name: name || '' },
      app_metadata: { plan: plan, roles: [plan] }
    })
  });

  // If user already exists (422), update their plan instead
  if (res.status === 422) {
    const listRes = await fetch(
      NETLIFY_IDENTITY_URL + '/admin/users?email=' + encodeURIComponent(email),
      { headers: { 'Authorization': 'Bearer ' + NETLIFY_IDENTITY_TOKEN } }
    );
    const data = await listRes.json();
    if (data.users && data.users.length > 0) {
      const userId = data.users[0].id;
      await fetch(NETLIFY_IDENTITY_URL + '/admin/users/' + userId, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + NETLIFY_IDENTITY_TOKEN
        },
        body: JSON.stringify({
          app_metadata: { plan: plan, roles: [plan] }
        })
      });
    }
  }

  // Send password recovery email so user can set their own password
  await fetch(NETLIFY_IDENTITY_URL + '/recover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email })
  });
}

async function revokeUser(email) {
  const listRes = await fetch(
    NETLIFY_IDENTITY_URL + '/admin/users?email=' + encodeURIComponent(email),
    { headers: { 'Authorization': 'Bearer ' + NETLIFY_IDENTITY_TOKEN } }
  );
  const data = await listRes.json();
  if (data.users && data.users.length > 0) {
    const userId = data.users[0].id;
    await fetch(NETLIFY_IDENTITY_URL + '/admin/users/' + userId, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + NETLIFY_IDENTITY_TOKEN
      },
      body: JSON.stringify({ app_metadata: { plan: null, roles: [] } })
    });
  }
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // Verify Stripe signature
  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Signature verification failed:', err.message);
    return { statusCode: 400, body: 'Webhook signature error: ' + err.message };
  }

  try {
    const obj = stripeEvent.data.object;

    if (stripeEvent.type === 'checkout.session.completed') {
      const email = obj.customer_details && obj.customer_details.email;
      const name  = obj.customer_details && obj.customer_details.name;
      // Determine plan from price ID in the session
      const priceId = obj.line_items && obj.line_items.data && obj.line_items.data[0]
        ? obj.line_items.data[0].price.id
        : null;
      const plan = priceId === PRICE_FCC ? 'fcc' : 'center';
      if (email) {
        await createOrUpdateUser(email, name, plan);
        console.log('Created user:', email, 'plan:', plan);
      }
    }

    if (stripeEvent.type === 'customer.subscription.deleted') {
      const customer = await stripe.customers.retrieve(obj.customer);
      if (customer.email) {
        await revokeUser(customer.email);
        console.log('Revoked user:', customer.email);
      }
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };

  } catch (err) {
    console.error('Handler error:', err.message);
    return { statusCode: 500, body: 'Server error: ' + err.message };
  }
};
