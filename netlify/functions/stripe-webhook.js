// Netlify Function: stripe-webhook.js
// Handles Stripe subscription events to create/update Netlify Identity users
// Deploy this file to: netlify/functions/stripe-webhook.js in your GitHub repo

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

const NETLIFY_SITE_ID = process.env.NETLIFY_SITE_ID;
const NETLIFY_ACCESS_TOKEN = process.env.NETLIFY_ACCESS_TOKEN;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Stripe Product IDs - replace with your actual Stripe product IDs
// Find them in Stripe Dashboard > Products
const PRODUCTS = {
  CENTER: process.env.STRIPE_CENTER_PRODUCT_ID,
  FCC: process.env.STRIPE_FCC_PRODUCT_ID,
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // Verify the webhook came from Stripe
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      event.headers['stripe-signature'],
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  // Handle subscription created or trial started
  if (
    stripeEvent.type === 'customer.subscription.created' ||
    stripeEvent.type === 'checkout.session.completed'
  ) {
    try {
      let customerEmail, subscriptionType, customerName;

      if (stripeEvent.type === 'checkout.session.completed') {
        const session = stripeEvent.data.object;
        customerEmail = session.customer_details.email;
        customerName = session.customer_details.name || '';
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        const productId = subscription.items.data[0].price.product;
        subscriptionType = productId === PRODUCTS.FCC ? 'fcc' : 'center';
      } else {
        const subscription = stripeEvent.data.object;
        const customer = await stripe.customers.retrieve(subscription.customer);
        customerEmail = customer.email;
        customerName = customer.name || '';
        const productId = subscription.items.data[0].price.product;
        subscriptionType = productId === PRODUCTS.FCC ? 'fcc' : 'center';
      }

      // Check if user already exists in Netlify Identity
      const searchRes = await fetch(
        `https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/identity/users?search=${encodeURIComponent(customerEmail)}`,
        {
          headers: {
            Authorization: `Bearer ${NETLIFY_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        }
      );
      const searchData = await searchRes.json();
      const existingUser = searchData.users && searchData.users.find(u => u.email === customerEmail);

      if (existingUser) {
        // Update existing user subscription type
        await fetch(
          `https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/identity/users/${existingUser.id}`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${NETLIFY_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              app_metadata: { subscription_type: subscriptionType, subscription_status: 'active' },
            }),
          }
        );
        console.log(`Updated existing user ${customerEmail} to ${subscriptionType}`);
      } else {
        // Create new Netlify Identity user
        const createRes = await fetch(
          `https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/identity/users`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${NETLIFY_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              email: customerEmail,
              user_metadata: { full_name: customerName },
              app_metadata: { subscription_type: subscriptionType, subscription_status: 'active' },
            }),
          }
        );
        const newUser = await createRes.json();

        // Send password setup email
        await fetch(
          `https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/identity/users/${newUser.id}/send_confirmation`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${NETLIFY_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
          }
        );
        console.log(`Created new user ${customerEmail} as ${subscriptionType}`);
      }

      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    } catch (err) {
      console.error('Error processing webhook:', err);
      return { statusCode: 500, body: `Server error: ${err.message}` };
    }
  }

  // Handle subscription cancelled or payment failed
  if (
    stripeEvent.type === 'customer.subscription.deleted' ||
    stripeEvent.type === 'invoice.payment_failed'
  ) {
    try {
      const subscription = stripeEvent.data.object;
      const customer = await stripe.customers.retrieve(subscription.customer);
      const customerEmail = customer.email;

      const searchRes = await fetch(
        `https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/identity/users?search=${encodeURIComponent(customerEmail)}`,
        {
          headers: { Authorization: `Bearer ${NETLIFY_ACCESS_TOKEN}` },
        }
      );
      const searchData = await searchRes.json();
      const user = searchData.users && searchData.users.find(u => u.email === customerEmail);

      if (user) {
        await fetch(
          `https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/identity/users/${user.id}`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${NETLIFY_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              app_metadata: { subscription_status: 'inactive' },
            }),
          }
        );
        console.log(`Revoked access for ${customerEmail}`);
      }

      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    } catch (err) {
      console.error('Error revoking access:', err);
      return { statusCode: 500, body: `Server error: ${err.message}` };
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
